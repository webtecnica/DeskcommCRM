/**
 * #3510 — A BUSCA PERIÓDICA DAS AVALIAÇÕES ACONTECE DE VERDADE.
 *
 * ─── O defeito que este arquivo existe para pegar ──────────────────────────
 *
 * Medido na fase 0: `sincronizarAvaliacoes` era chamada SÓ por teste — uma
 * ocorrência fora de `tests/`, a própria definição. Toda a suíte passava, o
 * build passava, e a avaliação nunca chegava à Central em instalação nenhuma.
 * `cron-routes-scheduled` não pega isso: ele compara rota × crontab, e a rota
 * nem existia.
 *
 * Por isso o caso 1 mede o EFEITO, não a chamada: uma avaliação do Google tem
 * de virar linha em `messages`. Quem apagar a chamada de `sincronizarAvaliacoes`
 * da rota derruba este teste — é a sabotagem que o brief cobra.
 *
 * ─── O banco é um dublê em memória, e o `fetch` também ────────────────────
 *
 * O dublê imita as constraints que a ingestão usa de verdade (23505 em
 * `messages(organization_id, external_id)` e em
 * `contacts(organization_id, social_identity)`), então a idempotência medida é
 * a do produto: a segunda rodada encontra o unique, não um "amém" do dublê.
 *
 * A cifra dos tokens é a da instalação (`fn_encrypt_oauth`/`fn_decrypt_oauth`);
 * aqui ela é substituída por um par base64 simétrico — o que se prova é o
 * FLUXO (grava cifrado, lê, renova, funde), não o AES, que já tem prova própria.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ESCOPO_DE_AVALIACOES } from "@/lib/channels/google-business/avaliacoes";
import {
  JANELA_DE_RENOVACAO_MS,
  registrarConsentimento,
  tokenDaOrganizacao,
} from "@/lib/channels/google-business/consentimento";
import {
  appDoNegocio,
  rodadaDasAvaliacoesDoGoogle,
} from "@/app/api/v1/cron/avaliacoes-do-google/route";

// A trilha de auditoria e o log não são o objeto desta suíte; sem o dublê eles
// tentariam falar com o Supabase e com o console durante a prova.
vi.mock("@/lib/audit", () => ({ audit: async () => {} }));
vi.mock("@/lib/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const AGORA = new Date("2026-11-13T12:00:00.000Z");
/**
 * O relógio da rodada, preso no mesmo instante de `AGORA`.
 *
 * Sem isso, o corte por tempo mediria o relógio de parede da máquina de CI
 * contra um `agora` fixo — e a rodada cortaria antes do primeiro canal só
 * porque o teste roda horas depois da data escrita aqui.
 */
const RELOGIO = () => AGORA.getTime();
const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const ESCOPO = "accounts/123456789/locations/987654321";
const AMBIENTE = {
  GOOGLE_BUSINESS_OAUTH_CLIENT_ID: "id-do-projeto.apps.googleusercontent.com",
  GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET: "segredo-do-projeto",
};
const APP = appDoNegocio(AMBIENTE)!;
const BASE_DA_API = "https://mybusiness.googleapis.com/v4";
const BASE_DO_TOKEN = "https://oauth2.googleapis.com/token";

type Linha = Record<string, unknown>;

/**
 * As tabelas do dublê, nomeadas uma a uma.
 *
 * `Record<string, Linha[]>` seria mais curto e pior: com `noUncheckedIndexedAccess`
 * (ligado no repo) cada acesso devolveria `Linha[] | undefined` e a prova
 * precisaria de `!` em toda asserção — ruído que esconde `undefined` de verdade.
 */
interface Tabelas {
  channel_sessions: Linha[];
  google_business_consentimentos: Linha[];
  contacts: Linha[];
  conversations: Linha[];
  messages: Linha[];
  [tabela: string]: Linha[];
}

interface BancoFalso {
  db: SupabaseClient;
  tabelas: Tabelas;
  escritas: { messages: number; contacts: number; conversations: number };
}

/**
 * Dublê do cliente Supabase: `select/eq/is/order/range`, `insert` com 23505 nas
 * duas constraints únicas, `update` e `upsert` por `organization_id`.
 */
function bancoFalso(inicial: Partial<Record<string, Linha[]>> = {}): BancoFalso {
  const tabelas: Tabelas = {
    channel_sessions: inicial.channel_sessions ?? [],
    google_business_consentimentos: inicial.google_business_consentimentos ?? [],
    contacts: inicial.contacts ?? [],
    conversations: inicial.conversations ?? [],
    messages: inicial.messages ?? [],
  };
  const escritas = { messages: 0, contacts: 0, conversations: 0 };
  let sequencia = 0;

  function consulta(tabela: string) {
    const filtros: [string, unknown][] = [];
    let modo: "select" | "insert" | "update" | "upsert" = "select";
    let payload: Linha | null = null;
    let ordenar: { coluna: string; asc: boolean } | null = null;
    let faixa: [number, number] | null = null;
    let chaveDoConflito: string | null = null;
    let cache: { data: Linha[] | null; error: { code: string } | null } | null = null;

    const casa = (linha: Linha) =>
      filtros.every(([coluna, valor]) =>
        valor === null ? (linha[coluna] ?? null) === null : linha[coluna] === valor,
      );

    const duplicada = (linhas: Linha[], nova: Linha): boolean => {
      if (tabela === "messages")
        return linhas.some(
          (l) => l.organization_id === nova.organization_id && l.external_id === nova.external_id,
        );
      if (tabela === "contacts")
        return linhas.some(
          (l) =>
            l.organization_id === nova.organization_id &&
            l.social_identity === nova.social_identity,
        );
      if (tabela === "conversations")
        return linhas.some(
          (l) =>
            l.organization_id === nova.organization_id &&
            l.channel_session_id === nova.channel_session_id &&
            l.contact_id === nova.contact_id,
        );
      if (tabela === "google_business_consentimentos")
        return linhas.some((l) => l.organization_id === nova.organization_id);
      return false;
    };

    function executar(): { data: Linha[] | null; error: { code: string } | null } {
      if (cache) return cache;
      const linhas = tabelas[tabela] ?? [];

      if (modo === "insert") {
        const nova: Linha = { id: `${tabela}-${(sequencia += 1)}`, ...payload };
        if (duplicada(linhas, nova)) {
          cache = { data: null, error: { code: "23505" } };
          return cache;
        }
        linhas.push(nova);
        if (tabela in escritas) escritas[tabela as "messages"] += 1;
        cache = { data: [nova], error: null };
        return cache;
      }

      if (modo === "upsert") {
        const chave = chaveDoConflito ?? "id";
        const existente = linhas.find((l) => l[chave] === payload?.[chave]);
        if (existente) Object.assign(existente, payload);
        else linhas.push({ id: `${tabela}-${(sequencia += 1)}`, ...payload });
        cache = { data: null, error: null };
        return cache;
      }

      if (modo === "update") {
        const alvos = linhas.filter(casa);
        for (const alvo of alvos) Object.assign(alvo, payload);
        cache = { data: alvos, error: null };
        return cache;
      }

      let saida = linhas.filter(casa);
      if (ordenar) {
        const { coluna, asc } = ordenar;
        saida = [...saida].sort(
          (a, b) => String(a[coluna] ?? "").localeCompare(String(b[coluna] ?? "")) * (asc ? 1 : -1),
        );
      }
      if (faixa) saida = saida.slice(faixa[0], faixa[1] + 1);
      cache = { data: saida.map((l) => ({ ...l })), error: null };
      return cache;
    }

    const api: Record<string, unknown> = {
      select() {
        return api;
      },
      insert(linha: Linha) {
        modo = "insert";
        payload = linha;
        return api;
      },
      update(linha: Linha) {
        modo = "update";
        payload = linha;
        return api;
      },
      upsert(linha: Linha, opcoes?: { onConflict?: string }) {
        modo = "upsert";
        payload = linha;
        chaveDoConflito = opcoes?.onConflict ?? null;
        return api;
      },
      eq(coluna: string, valor: unknown) {
        filtros.push([coluna, valor]);
        return api;
      },
      is(coluna: string, valor: unknown) {
        filtros.push([coluna, valor]);
        return api;
      },
      in(coluna: string, valores: unknown[]) {
        filtros.push([coluna, valores.length === 1 ? valores[0] : "__in__"]);
        return api;
      },
      order(coluna: string, opcoes?: { ascending?: boolean }) {
        ordenar = { coluna, asc: opcoes?.ascending !== false };
        return api;
      },
      range(de: number, ate: number) {
        faixa = [de, ate];
        return api;
      },
      limit(n: number) {
        faixa = [0, n - 1];
        return api;
      },
      maybeSingle: async () => {
        const { data, error } = executar();
        return { data: error ? null : ((data ?? [])[0] ?? null), error };
      },
      single: async () => {
        const { data, error } = executar();
        return { data: error ? null : ((data ?? [])[0] ?? null), error };
      },
      then(resolver: (valor: unknown) => unknown, rejeitar?: (erro: unknown) => unknown) {
        return Promise.resolve(executar()).then(resolver, rejeitar);
      },
    };
    return api;
  }

  const db = {
    from: (tabela: string) => consulta(tabela),
    // A cifra da instalação, em versão simétrica legível: o fluxo é o que se prova.
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome === "fn_encrypt_oauth") {
        return { data: `cifrado:${Buffer.from(String(args.plaintext)).toString("base64")}`, error: null };
      }
      if (nome === "fn_decrypt_oauth") {
        const bruto = String(args.ciphertext).replace(/^\\x/, "");
        if (!bruto.startsWith("cifrado:")) return { data: null, error: { message: "corrompido" } };
        return {
          data: Buffer.from(bruto.slice("cifrado:".length), "base64").toString("utf8"),
          error: null,
        };
      }
      return { data: null, error: { message: `rpc não dublada: ${nome}` } };
    },
  } as unknown as SupabaseClient;

  return { db, tabelas, escritas };
}

interface EstadoDoGoogle {
  chamadas: { url: string; autorizacao: string | null; corpo: string | null }[];
  /** Resposta do endpoint de token. `status` 400 = recusa (`invalid_grant`). */
  token: { corpo: unknown; status: number };
  /** Avaliações devolvidas pela API, por página. */
  avaliacoes: unknown[];
  proximaPagina: string | null;
  /** Falha de rede na renovação (nada foi decidido do lado do Google). */
  redeFora: boolean;
}

function googleFalso(): { estado: EstadoDoGoogle; buscar: typeof fetch } {
  const estado: EstadoDoGoogle = {
    chamadas: [],
    token: {
      status: 200,
      corpo: {
        access_token: "access-renovado",
        expires_in: 3600,
        token_type: "Bearer",
        scope: ESCOPO_DE_AVALIACOES,
      },
    },
    avaliacoes: [],
    proximaPagina: null,
    redeFora: false,
  };

  const buscar = (async (url: string, init?: RequestInit) => {
    const endereco = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    estado.chamadas.push({
      url: endereco,
      autorizacao: headers.Authorization ?? null,
      corpo: typeof init?.body === "string" ? init.body : null,
    });

    if (endereco.startsWith(BASE_DO_TOKEN)) {
      if (estado.redeFora) throw new Error("ECONNRESET");
      return new Response(JSON.stringify(estado.token.corpo), { status: estado.token.status });
    }

    return new Response(
      JSON.stringify({ reviews: estado.avaliacoes, nextPageToken: estado.proximaPagina }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  return { estado, buscar };
}

function avaliacao(id: string, autor = "Ana"): unknown {
  return {
    name: `${ESCOPO}/reviews/${id}`,
    starRating: "FIVE",
    comment: `avaliação ${id}`,
    createTime: "2026-11-12T10:00:00Z",
    updateTime: "2026-11-12T10:00:00Z",
    reviewer: { displayName: autor },
  };
}

function canal(organizationId = ORG, id = CANAL, escopo: string | null = ESCOPO): Linha {
  return {
    id,
    organization_id: organizationId,
    provider: "google_business",
    archived_at: null,
    metadata: escopo ? { google_business_escopo: escopo } : {},
  };
}

async function comConsentimento(
  db: SupabaseClient,
  organizationId: string,
  opcoes: { expiraEm?: string; refreshToken?: string; accessToken?: string } = {},
): Promise<void> {
  const registro = await registrarConsentimento(db, {
    organizationId,
    refreshToken: opcoes.refreshToken ?? "refresh-1",
    accessToken: opcoes.accessToken ?? "access-1",
    escopos: [ESCOPO_DE_AVALIACOES],
    expiraEm: opcoes.expiraEm ?? new Date(AGORA.getTime() + 60 * 60 * 1000).toISOString(),
    agora: AGORA,
  });
  expect(registro.ok, "o consentimento de teste tem de gravar").toBe(true);
}

describe("o cron das avaliações chama a sincronização", () => {
  it("uma avaliação do Google vira mensagem na Central — o EFEITO, não a chamada", async () => {
    const banco = bancoFalso({ channel_sessions: [canal()] });
    await comConsentimento(banco.db, ORG);
    const { estado, buscar } = googleFalso();
    estado.avaliacoes = [avaliacao("a1")];

    const resumo = await rodadaDasAvaliacoesDoGoogle(banco.db as never, {
      agora: AGORA,
      relogio: RELOGIO,
      ambiente: AMBIENTE,
      buscar,
      baseDaApi: BASE_DA_API,
      baseDoToken: BASE_DO_TOKEN,
    });

    expect(resumo.examinadas).toBe(1);
    expect(resumo.sincronizadas).toBe(1);
    expect(resumo.novas).toBe(1);
    // A prova dura: a avaliação virou mensagem com o id externo do Google.
    expect(banco.tabelas.messages).toHaveLength(1);
    expect(banco.tabelas.messages[0]?.external_id).toBe(`googlebusiness:${ESCOPO}/reviews/a1`);
    expect(banco.tabelas.conversations).toHaveLength(1);
    expect(banco.tabelas.conversations[0]?.channel).toBe("googlebusiness");
  });

  it("duas rodadas seguidas NÃO duplicam: a segunda conta como repetida", async () => {
    const banco = bancoFalso({ channel_sessions: [canal()] });
    await comConsentimento(banco.db, ORG);
    const { estado, buscar } = googleFalso();
    estado.avaliacoes = [avaliacao("a1"), avaliacao("a2", "Bruno")];

    const opcoes = {
      agora: AGORA,
      relogio: RELOGIO,
      ambiente: AMBIENTE,
      buscar,
      baseDaApi: BASE_DA_API,
      baseDoToken: BASE_DO_TOKEN,
    };
    const primeira = await rodadaDasAvaliacoesDoGoogle(banco.db as never, opcoes);
    const segunda = await rodadaDasAvaliacoesDoGoogle(banco.db as never, opcoes);

    expect(primeira.novas).toBe(2);
    expect(primeira.repetidas).toBe(0);
    expect(segunda.novas).toBe(0);
    expect(segunda.repetidas).toBe(2);
    // O banco tem DUAS linhas, não quatro — é a idempotência medida.
    expect(banco.tabelas.messages).toHaveLength(2);
  });

  it("organização sem consentimento não chama o Google e entra no resumo com o motivo", async () => {
    const banco = bancoFalso({ channel_sessions: [canal()] });
    const { estado, buscar } = googleFalso();

    const resumo = await rodadaDasAvaliacoesDoGoogle(banco.db as never, {
      agora: AGORA,
      relogio: RELOGIO,
      ambiente: AMBIENTE,
      buscar,
      baseDaApi: BASE_DA_API,
      baseDoToken: BASE_DO_TOKEN,
    });

    expect(resumo.semConsentimento).toBe(1);
    expect(resumo.sincronizadas).toBe(0);
    expect(estado.chamadas).toHaveLength(0);
    expect(banco.tabelas.messages).toHaveLength(0);
  });

  it("sem o par OAuth da instalação a rodada não varre nada", async () => {
    const banco = bancoFalso({ channel_sessions: [canal()] });
    await comConsentimento(banco.db, ORG);
    const { estado, buscar } = googleFalso();

    const resumo = await rodadaDasAvaliacoesDoGoogle(banco.db as never, {
      agora: AGORA,
      app: null,
      ambiente: {},
      buscar,
      baseDaApi: BASE_DA_API,
      baseDoToken: BASE_DO_TOKEN,
    });

    expect(resumo.semCredencial).toBe(1);
    expect(resumo.examinadas).toBe(0);
    expect(estado.chamadas).toHaveLength(0);
  });

  it("pagina as sessões do canal: três canais em páginas de dois são todos examinados", async () => {
    const banco = bancoFalso({
      channel_sessions: [
        canal(ORG, CANAL, ESCOPO),
        canal(OUTRA_ORG, "44444444-4444-4444-8444-444444444444", ESCOPO),
        canal("55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666", ESCOPO),
      ],
    });
    // Só a primeira autorizou: as outras duas provam que a varredura chegou nelas.
    await comConsentimento(banco.db, ORG);
    const { buscar } = googleFalso();

    const resumo = await rodadaDasAvaliacoesDoGoogle(banco.db as never, {
      agora: AGORA,
      relogio: RELOGIO,
      ambiente: AMBIENTE,
      buscar,
      baseDaApi: BASE_DA_API,
      baseDoToken: BASE_DO_TOKEN,
      tamanhoDaPagina: 2,
    });

    expect(resumo.examinadas).toBe(3);
    expect(resumo.semConsentimento).toBe(2);
    expect(resumo.sincronizadas).toBe(1);
  });

  it("corta por TEMPO: com o orçamento estourado a rodada não processa canal nenhum", async () => {
    const banco = bancoFalso({ channel_sessions: [canal()] });
    await comConsentimento(banco.db, ORG);
    const { estado, buscar } = googleFalso();

    // O relógio salta 120 s na segunda leitura: a rodada já gastou o orçamento
    // antes de chegar ao primeiro canal. (Relógio injetado, não `sleep`: a
    // borda do corte é uma decisão sobre o relógio, e esperar não a mede.)
    let tique = AGORA.getTime();
    const relogioQueSalta = () => (tique += 120_000);
    const resumo = await rodadaDasAvaliacoesDoGoogle(banco.db as never, {
      agora: AGORA,
      relogio: relogioQueSalta,
      ambiente: AMBIENTE,
      buscar,
      baseDaApi: BASE_DA_API,
      baseDoToken: BASE_DO_TOKEN,
      orcamentoMs: 45_000,
    });

    expect(resumo.cortouPorTempo).toBe(true);
    expect(resumo.examinadas).toBe(0);
    expect(estado.chamadas).toHaveLength(0);
  });
});

describe("o refresh token da organização", () => {
  it("token vencendo é renovado ANTES de expirar, e o novo é gravado com validade", async () => {
    const banco = bancoFalso();
    await comConsentimento(banco.db, ORG, {
      expiraEm: new Date(AGORA.getTime() + JANELA_DE_RENOVACAO_MS - 60_000).toISOString(),
      refreshToken: "refresh-antigo",
      accessToken: "access-velho",
    });
    const { estado, buscar } = googleFalso();

    const acesso = await tokenDaOrganizacao(banco.db, ORG, {
      app: APP,
      agora: AGORA,
      buscar,
      base: BASE_DO_TOKEN,
    });

    expect(acesso).toEqual({ ok: true, token: "access-renovado", renovado: true });
    const renovacao = estado.chamadas[0];
    expect(renovacao?.url).toBe(BASE_DO_TOKEN);
    expect(renovacao?.corpo).toContain("grant_type=refresh_token");
    expect(renovacao?.corpo).toContain("refresh_token=refresh-antigo");

    const linha = banco.tabelas.google_business_consentimentos[0]!;
    // Gravado CIFRADO, com validade nova e o escopo preservado.
    expect(String(linha.access_token_encrypted)).not.toContain("access-renovado");
    expect(linha.expira_em).toBe(new Date(AGORA.getTime() + 3600_000).toISOString());
    expect(linha.escopos).toEqual([ESCOPO_DE_AVALIACOES]);
    expect(linha.status).toBe("ativo");
    // A resposta da renovação não traz `refresh_token`: o antigo tem de ficar.
    expect(linha.refresh_token_encrypted).toBeTypeOf("string");
  });

  it("token ainda válido é usado sem chamar o endpoint de token", async () => {
    const banco = bancoFalso();
    await comConsentimento(banco.db, ORG, { accessToken: "access-bom" });
    const { estado, buscar } = googleFalso();

    const acesso = await tokenDaOrganizacao(banco.db, ORG, {
      app: APP,
      agora: AGORA,
      buscar,
      base: BASE_DO_TOKEN,
    });

    expect(acesso).toEqual({ ok: true, token: "access-bom", renovado: false });
    expect(estado.chamadas).toHaveLength(0);
  });

  it("refresh recusado NÃO apaga o consentimento: marca reautorizar e registra o motivo", async () => {
    const banco = bancoFalso();
    await comConsentimento(banco.db, ORG, {
      expiraEm: new Date(AGORA.getTime() + 60_000).toISOString(),
    });
    const { estado, buscar } = googleFalso();
    estado.token = { status: 400, corpo: { error: "invalid_grant" } };

    const acesso = await tokenDaOrganizacao(banco.db, ORG, {
      app: APP,
      agora: AGORA,
      buscar,
      base: BASE_DO_TOKEN,
    });

    expect(acesso.ok).toBe(false);
    if (acesso.ok) throw new Error("esperava recusa");
    expect(acesso.motivo).toBe("reautorizar");

    // A LINHA CONTINUA — com o motivo escrito nela.
    const linhas = banco.tabelas.google_business_consentimentos;
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.status).toBe("reautorizar");
    expect(String(linhas[0]?.ultimo_erro)).toContain("invalid_grant");
    expect(linhas[0]?.refresh_token_encrypted).toBeTypeOf("string");
  });

  it("recusa já registrada não tenta de novo nem chama o Google", async () => {
    const banco = bancoFalso();
    await comConsentimento(banco.db, ORG);
    banco.tabelas.google_business_consentimentos[0]!.status = "reautorizar";
    const { estado, buscar } = googleFalso();

    const acesso = await tokenDaOrganizacao(banco.db, ORG, {
      app: APP,
      agora: AGORA,
      buscar,
      base: BASE_DO_TOKEN,
    });

    expect(acesso).toMatchObject({ ok: false, motivo: "reautorizar" });
    expect(estado.chamadas).toHaveLength(0);
  });

  it("falha de rede é TRANSITÓRIA: registra o motivo e mantém o consentimento ativo", async () => {
    const banco = bancoFalso();
    await comConsentimento(banco.db, ORG, {
      expiraEm: new Date(AGORA.getTime() + 60_000).toISOString(),
    });
    const { estado, buscar } = googleFalso();
    estado.redeFora = true;

    const acesso = await tokenDaOrganizacao(banco.db, ORG, {
      app: APP,
      agora: AGORA,
      buscar,
      base: BASE_DO_TOKEN,
    });

    expect(acesso.ok).toBe(false);
    if (acesso.ok) throw new Error("esperava falha");
    expect(acesso.motivo).toBe("falha_na_renovacao");

    const linha = banco.tabelas.google_business_consentimentos[0]!;
    expect(linha.status).toBe("ativo");
    expect(String(linha.ultimo_erro)).toContain("ECONNRESET");
  });

  it("o consentimento guarda escopo e validade e nunca o token em claro", async () => {
    const banco = bancoFalso();
    await comConsentimento(banco.db, ORG, { refreshToken: "segredo-cru" });

    const linha = banco.tabelas.google_business_consentimentos[0]!;
    expect(linha.escopos).toEqual([ESCOPO_DE_AVALIACOES]);
    expect(linha.expira_em).toBe(new Date(AGORA.getTime() + 3600_000).toISOString());
    expect(String(linha.refresh_token_encrypted)).not.toContain("segredo-cru");
  });
});
