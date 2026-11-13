/**
 * O CONSENTIMENTO DO PERFIL DA EMPRESA — por ORGANIZAÇÃO, não por instalação.
 *
 * ─── Por que a instalação não serve ─────────────────────────────────────────
 *
 * O app OAuth (`GOOGLE_BUSINESS_OAUTH_CLIENT_ID`/`_SECRET`, ou o app guardado em
 * `platform_google_oauth`) é da INSTALAÇÃO: é ele que pede o consentimento e é
 * ele que troca o código. O que ele NÃO pode ser é o dono do acesso — o refresh
 * token pertence à conta Google da EMPRESA que autorizou as avaliações do
 * próprio negócio. Guardar um token só por instalação faria a segunda empresa
 * ler as avaliações da primeira.
 *
 * Por isso a linha é `(organization_id)` única, com o `refresh_token` CIFRADO
 * (mesmo `fn_encrypt_oauth` dos outros segredos do repo), o ESCOPO concedido e
 * a VALIDADE do access token. Sem escopo gravado não se sabe o que foi
 * autorizado; sem validade, renova-se a cada chamada ou se usa um token morto —
 * os dois jeitos de errar estão fechados aqui.
 *
 * ─── A renovação NUNCA apaga o consentimento ──────────────────────────────
 *
 * Recusa do Google (`invalid_grant`, conta revogada, app removido) é um estado
 * da CONEXÃO, não um motivo para sumir com a linha: quem apaga deixa a
 * organização sem registro de que autorizou e sem motivo visível na tela. A
 * recusa grava `status = 'reautorizar'` + o motivo em `ultimo_erro`, e a
 * rodada seguinte pula a organização até alguém reconectar. Falha TRANSITÓRIA
 * (rede, 5xx) grava só o motivo e mantém o status — o próximo tick tenta de
 * novo sem exigir reconexão de ninguém.
 *
 * ─── O que este módulo NÃO faz ────────────────────────────────────────────
 *
 * Não abre a tela de consentimento nem troca o `code` do retorno: o caminho de
 * ENTRADA do consentimento (`registrarConsentimento`) fica aqui pronto para a
 * rota de callback que fecha a fatia, e é ela que precisa existir para a linha
 * nascer numa instalação real. O que a fatia do cron entrega é o consumo: ler o
 * consentimento, renovar antes de expirar e dizer, sem chamar o Google, por que
 * uma organização não pode ser sincronizada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ENDERECO_DE_TOKEN,
  fundirTokens,
  lerRespostaDeToken,
  precisaRenovar,
  type TokenDoGoogle,
} from "@/lib/agenda/google/oauth";
import { logger } from "@/lib/logger";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { ESCOPO_DE_AVALIACOES } from "./avaliacoes";

/** A tabela do consentimento. Uma linha por organização (unique no banco). */
export const TABELA_DO_CONSENTIMENTO = "google_business_consentimentos";

/**
 * Quanto antes do vencimento a rodada já renova.
 *
 * O cron é HORÁRIO e o access token do Google vive cerca de uma hora: sem folga,
 * a rodada que chega no minuto exato encontra o token vencendo e a chamada à API
 * sai com um token que morre no meio da paginação. Quinze minutos é a mesma
 * janela da renovação da Agenda (`JANELA_DE_RENOVACAO_MS`), e cobre um tick
 * atrasado do `crond`.
 */
export const JANELA_DE_RENOVACAO_MS = 15 * 60 * 1000;

/** Prazo da chamada de renovação. O mesmo da Agenda: o Google não demora 10 s. */
const PRAZO_DA_RENOVACAO_MS = 10_000;

/**
 * O `AbortSignal` com prazo, quando o runtime oferece `AbortSignal.timeout`.
 *
 * Existe por causa da prova: o ambiente de teste (jsdom) nem sempre expõe
 * `AbortSignal.timeout`, e um `TypeError` ali derrubaria o teste por instrumento
 * — parecendo defeito do produto. Sem o método, a chamada sai sem prazo, que é
 * o comportamento anterior e não muda nenhuma decisão deste arquivo.
 */
function sinalDePrazo(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** O par OAuth da instalação, pelo mínimo que a renovação precisa. */
export interface AppDoNegocio {
  clientId: string;
  clientSecret: string;
}

/** O consentimento como o resto do código o vê — sem o token em claro. */
export interface ConsentimentoDoNegocio {
  organizationId: string;
  escopos: string[];
  /** Vencimento do access token, ISO-8601. `null` = não sabemos. */
  expiraEm: string | null;
  /** `true` = o Google recusou a renovação; a organização precisa reconectar. */
  precisaDeNovaAutorizacao: boolean;
  ultimoErro: string | null;
}

export interface EntradaDeConsentimento {
  organizationId: string;
  /** O que o Google devolveu no consentimento — obrigatório: sem ele não há renovação. */
  refreshToken: string;
  accessToken?: string | null;
  /** O `scope` da resposta, em lista. Vazio = assume o escopo que a leitura exige. */
  escopos?: readonly string[];
  /** Vencimento do access token, ISO-8601. */
  expiraEm?: string | null;
  agora?: Date;
}

export type ResultadoDoRegistro =
  | { ok: true }
  /** A cifra da instalação não respondeu (`fn_encrypt_oauth`): nada foi gravado. */
  | { ok: false; motivo: "cifra_indisponivel" };

/**
 * Grava (ou substitui) o consentimento da organização.
 *
 * O `refresh_token` entra CIFRADO e nunca é devolvido por leitura nenhuma da
 * API — mesma disciplina de `tenant_integrations`. O upsert é por
 * `organization_id`: reconectar a mesma empresa troca o token em vez de
 * acumular linhas, e o índice único do banco é a garantia contra corrida entre
 * dois consentimentos simultâneos.
 */
export async function registrarConsentimento(
  db: SupabaseClient,
  entrada: EntradaDeConsentimento,
): Promise<ResultadoDoRegistro> {
  const refreshToken = entrada.refreshToken.trim();
  if (!refreshToken) return { ok: false, motivo: "cifra_indisponivel" };

  const refreshCifrado = await encryptWebhookSecret(db, refreshToken);
  if (!refreshCifrado) {
    logger.warn("[avaliacoes.consentimento] cifra indisponível: o consentimento não foi gravado", {
      organization_id: entrada.organizationId,
    });
    return { ok: false, motivo: "cifra_indisponivel" };
  }

  const access = (entrada.accessToken ?? "").trim();
  const accessCifrado = access ? await encryptWebhookSecret(db, access) : null;
  const agora = (entrada.agora ?? new Date()).toISOString();
  const escopos = entrada.escopos && entrada.escopos.length > 0
    ? [...entrada.escopos]
    : [ESCOPO_DE_AVALIACOES];

  const { error } = await db.from(TABELA_DO_CONSENTIMENTO).upsert(
    {
      organization_id: entrada.organizationId,
      refresh_token_encrypted: refreshCifrado,
      access_token_encrypted: accessCifrado,
      escopos,
      expira_em: entrada.expiraEm ?? null,
      status: "ativo",
      ultimo_erro: null,
      autorizado_em: agora,
      updated_at: agora,
    },
    { onConflict: "organization_id" },
  );

  if (error) {
    logger.warn("[avaliacoes.consentimento] gravação do consentimento falhou", {
      organization_id: entrada.organizationId,
      codigo: error.code,
    });
    return { ok: false, motivo: "cifra_indisponivel" };
  }
  return { ok: true };
}

interface LinhaDoConsentimento {
  organization_id: string;
  refresh_token_encrypted: string | null;
  access_token_encrypted: string | null;
  escopos: string[] | null;
  expira_em: string | null;
  status: string | null;
  ultimo_erro: string | null;
}

export type AcessoAoNegocio =
  | { ok: true; token: string; renovado: boolean }
  | { ok: false; motivo: "sem_consentimento" }
  | { ok: false; motivo: "sem_credencial"; faltando: string[] }
  | { ok: false; motivo: "reautorizar"; detalhe: string }
  | { ok: false; motivo: "falha_na_renovacao"; detalhe: string };

interface OpcoesDoAcesso {
  app: AppDoNegocio;
  agora: Date;
  /** Injetáveis para a prova não tocar a rede. */
  buscar?: typeof fetch;
  base?: string;
}

/**
 * A recusa é definitiva?
 *
 * `invalid_grant` (e o 400/401 do endpoint de token) significa que a autorização
 * acabou: só uma pessoa reconectando resolve. Rede (`status === null`) e 5xx são
 * soluços — insistir no tick seguinte é o certo, e exigir reconexão por causa de
 * um timeout seria mentir para o operador.
 */
export function ehRecusaDefinitiva(leitura: {
  motivo: string;
  status: number | null;
}): boolean {
  if (leitura.status === 400 || leitura.status === 401 || leitura.status === 403) return true;
  return leitura.motivo === "erro_do_google" && leitura.status !== null;
}

/**
 * Um access token VÁLIDO para a organização, renovando antes de expirar.
 *
 * A ordem é a mesma do resto do repo: consentimento → credencial da instalação →
 * renovação. Cada saída negativa tem motivo próprio porque a tela e o log
 * precisam distinguir "a empresa não autorizou" de "a instalação não tem app
 * OAuth" — as duas coisas pedem ações diferentes de pessoas diferentes.
 *
 * ⚠️ A resposta da renovação vem SEM `refresh_token`: tudo passa por
 * `fundirTokens` antes de gravar. Gravar o que chegou apagaria a chave que
 * acabou de renovar e mataria a conexão na hora seguinte.
 */
export async function tokenDaOrganizacao(
  db: SupabaseClient,
  organizationId: string,
  opcoes: OpcoesDoAcesso,
): Promise<AcessoAoNegocio> {
  const faltando = (["clientId", "clientSecret"] as const).filter(
    (campo) => !opcoes.app[campo]?.trim(),
  );
  if (faltando.length > 0) {
    return { ok: false, motivo: "sem_credencial", faltando: [...faltando] };
  }

  const { data, error } = await db
    .from(TABELA_DO_CONSENTIMENTO)
    .select(
      "organization_id, refresh_token_encrypted, access_token_encrypted, escopos, expira_em, status, ultimo_erro",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    logger.warn("[avaliacoes.consentimento] leitura do consentimento falhou na renovação", {
      organization_id: organizationId,
      codigo: error.code,
    });
    return { ok: false, motivo: "sem_consentimento" };
  }

  const linha = data as LinhaDoConsentimento | null;
  if (!linha) return { ok: false, motivo: "sem_consentimento" };
  if (linha.status === "reautorizar") {
    return {
      ok: false,
      motivo: "reautorizar",
      detalhe: linha.ultimo_erro ?? "o Google recusou a última renovação",
    };
  }

  const accessCifrado = (linha.access_token_encrypted ?? "").trim();
  if (accessCifrado && !precisaRenovar(linha.expira_em, opcoes.agora, JANELA_DE_RENOVACAO_MS)) {
    const accessValido = await decryptWebhookSecret(db, accessCifrado);
    // Decifra que falha (chave mestra trocada) não vira "sem consentimento": o
    // caminho é renovar, que reescreve o access token com a chave atual.
    if (accessValido) return { ok: true, token: accessValido, renovado: false };
  }

  const refreshCifrado = (linha.refresh_token_encrypted ?? "").trim();
  if (!refreshCifrado) return { ok: false, motivo: "sem_consentimento" };
  const refresh = await decryptWebhookSecret(db, refreshCifrado);
  if (!refresh) {
    // O problema é da cifra da instalação, não da autorização: NÃO rebaixa o
    // consentimento nem manda reconectar. O tick seguinte tenta de novo.
    const detalhe = "o refresh token guardado não pôde ser decifrado nesta instalação";
    await registrarMotivo(db, organizationId, detalhe, null);
    return { ok: false, motivo: "falha_na_renovacao", detalhe };
  }

  const leitura = await pedirRenovacao(opcoes, refresh);
  if (!leitura.ok) {
    const definitiva = ehRecusaDefinitiva(leitura);
    await registrarMotivo(db, organizationId, leitura.detalhe, definitiva ? "reautorizar" : null);
    logger.warn("[avaliacoes.consentimento] renovação recusada", {
      organization_id: organizationId,
      status: leitura.status,
      definitiva,
      motivo: leitura.motivo,
    });
    return definitiva
      ? { ok: false, motivo: "reautorizar", detalhe: leitura.detalhe }
      : { ok: false, motivo: "falha_na_renovacao", detalhe: leitura.detalhe };
  }

  const anterior: TokenDoGoogle = {
    access_token: "",
    refresh_token: refresh,
    scope: Array.isArray(linha.escopos) ? linha.escopos : [],
    token_type: "Bearer",
    expira_em: linha.expira_em ?? opcoes.agora.toISOString(),
  };
  const fundido = fundirTokens(anterior, leitura.token);

  const accessNovo = await encryptWebhookSecret(db, fundido.access_token);
  if (!accessNovo) {
    const detalhe = "a cifra da instalação não respondeu ao gravar o token renovado";
    await registrarMotivo(db, organizationId, detalhe, null);
    return { ok: false, motivo: "falha_na_renovacao", detalhe };
  }
  // O refresh token pode ROTACIONAR: quando o Google devolve um novo, ele é o
  // que vale — o antigo deixa de funcionar. Cifra o que a fusão escolheu.
  const refreshAtual = fundido.refresh_token ?? refresh;
  const refreshNovo = refreshAtual === refresh ? null : await encryptWebhookSecret(db, refreshAtual);

  const { error: erroAoGravar } = await db
    .from(TABELA_DO_CONSENTIMENTO)
    .update({
      access_token_encrypted: accessNovo,
      ...(refreshNovo ? { refresh_token_encrypted: refreshNovo } : {}),
      escopos: fundido.scope.length > 0 ? fundido.scope : (linha.escopos ?? []),
      expira_em: fundido.expira_em,
      status: "ativo",
      ultimo_erro: null,
      updated_at: opcoes.agora.toISOString(),
    })
    .eq("organization_id", organizationId);

  if (erroAoGravar) {
    // O token vale para esta rodada mesmo sem gravar; o próximo tick renova de
    // novo. Dizer o contrário faria a sincronização perder o trabalho já feito.
    logger.warn("[avaliacoes.consentimento] renovação não foi gravada", {
      organization_id: organizationId,
      codigo: erroAoGravar.code,
    });
  }
  return { ok: true, token: fundido.access_token, renovado: true };
}

/**
 * Registra o motivo SEM tocar no token.
 *
 * `status` só muda quando a recusa é definitiva; `null` mantém o que estava. É o
 * "refresh recusado não apaga o consentimento sem registro": a linha continua
 * lá, com o porquê escrito nela.
 */
async function registrarMotivo(
  db: SupabaseClient,
  organizationId: string,
  detalhe: string,
  status: "reautorizar" | null,
): Promise<void> {
  const { error } = await db
    .from(TABELA_DO_CONSENTIMENTO)
    .update({
      ultimo_erro: detalhe.slice(0, 500),
      ...(status ? { status } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId);
  if (error) {
    logger.warn("[avaliacoes.consentimento] o motivo da recusa não foi gravado", {
      organization_id: organizationId,
      codigo: error.code,
    });
  }
}

async function pedirRenovacao(
  opcoes: OpcoesDoAcesso,
  refreshToken: string,
): Promise<ReturnType<typeof lerRespostaDeToken>> {
  const buscar = opcoes.buscar ?? fetch;
  const base = (opcoes.base ?? ENDERECO_DE_TOKEN).replace(/\/+$/, "");

  let resposta: Response;
  try {
    resposta = await buscar(base, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: opcoes.app.clientId,
        client_secret: opcoes.app.clientSecret,
        grant_type: "refresh_token",
      }).toString(),
      signal: sinalDePrazo(PRAZO_DA_RENOVACAO_MS),
      cache: "no-store",
    });
  } catch (erro) {
    // Sem resposta do Google, nada foi decidido do lado de lá: transitório.
    const motivo = erro instanceof Error ? erro.message : String(erro);
    return {
      ok: false,
      motivo: "resposta_invalida",
      detalhe: `sem resposta do Google: ${motivo}`,
      status: null,
    };
  }

  let bruto: unknown;
  try {
    bruto = await resposta.json();
  } catch {
    return {
      ok: false,
      motivo: "resposta_invalida",
      detalhe: `HTTP ${resposta.status} com corpo ilegível`,
      status: resposta.ok ? null : resposta.status,
    };
  }
  return lerRespostaDeToken(bruto, { agora: opcoes.agora, status: resposta.ok ? null : resposta.status });
}
