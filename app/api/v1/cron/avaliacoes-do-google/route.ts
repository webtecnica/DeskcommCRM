/**
 * GET/POST /api/v1/cron/avaliacoes-do-google — a busca PERIÓDICA das avaliações.
 *
 * ─── O defeito que esta rota fecha (medido na fase 0 da #3510) ─────────────
 *
 * `sincronizarAvaliacoes` existia, tinha teste, tinha doc — e **só era chamada
 * por teste**: uma única ocorrência fora de `tests/`, a própria definição. É a
 * mesma classe de defeito que `tests/unit/cron-routes-scheduled.test.ts`
 * descreve para rota sem agendamento: nada dá erro, o teste passa, e a feature
 * simplesmente não acontece. Aqui o que faltava era quem chamasse a função.
 *
 * ─── O que a rodada faz, e em que ordem ───────────────────────────────────
 *
 * 1. Portão do piso ocioso (`avaliacoes_do_google`): sem canal de Perfil da
 *    Empresa com escopo, sai antes de qualquer outra ida ao PostgREST.
 * 2. Chave do módulo: desligado (o padrão) sai sem varrer nada.
 * 3. Varre as sessões do canal PAGINADAS, e para cada uma: consentimento da
 *    organização → renovação ANTES de expirar → `sincronizarAvaliacoes`.
 * 4. Corte por TEMPO dentro do orçamento: a rodada para no meio e a próxima
 *    continua — paginação sem teto de tempo é o que faz um cron de hora em hora
 *    atrasar a batida seguinte.
 *
 * ─── Uma organização sem consentimento NÃO chama o Google ─────────────────
 *
 * É o critério da fatia: sem linha de consentimento, sem app OAuth na
 * instalação ou com a renovação recusada, a organização é contada com o motivo
 * próprio e a rodada segue para a próxima. Nenhuma chamada à API do Google sai
 * nesses casos — e o motivo fica no resumo, não num `console.log` que ninguém lê.
 *
 * ─── Idempotência ─────────────────────────────────────────────────────────
 *
 * Quem garante é a ingestão: `messages(organization_id, external_id)` é único e
 * o `23505` conta como "já estava lá". Rodar duas vezes seguidas grava UMA
 * avaliação por avaliação do Google — a prova disso está no teste da rota, que
 * roda a rodada duas vezes contra o mesmo banco e mede `novas` e `repetidas`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import type { AmbienteDasAvaliacoes } from "@/lib/channels/google-business/avaliacoes";
import {
  tokenDaOrganizacao,
  type AppDoNegocio,
} from "@/lib/channels/google-business/consentimento";
import { sincronizarAvaliacoes } from "@/lib/channels/google-business/sincronizar";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { env } from "@/lib/env";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Orçamento da rodada. A linha do scheduler dá 120 s de `timeout`; 45 s deixa
 * folga para o fechamento da resposta e para o banco — e o corte é o que impede
 * uma instalação com muitas empresas de estourar o teto do `crond`.
 */
export const ORCAMENTO_MS = 45_000;

/** Quantas sessões do canal por página do PostgREST. */
export const TAMANHO_DA_PAGINA_DE_CANAIS = 25;

/**
 * Os passos de nível superior que rodam DEPOIS do portão do piso ocioso
 * (`tests/unit/cron-passa-pelo-portao.test.ts` lê esta lista pelo AST).
 *
 * Todos os quatro só fazem sentido quando existe canal para sincronizar: sair
 * antes deles em instalação ociosa é o objetivo do portão, não um efeito
 * colateral.
 */
export const PASSOS_DEPOIS_DO_PORTAO = [
  "const admin",
  'if (!(await moduloLigado(admin, "google_business")))',
  "const resumo",
  "return",
] as const;

export interface ResumoDaRodadaDeAvaliacoes {
  /** Sessões do canal examinadas nesta rodada (paginação + corte por tempo). */
  examinadas: number;
  /** Organizações que autorizaram e cuja sincronização rodou. */
  sincronizadas: number;
  /** Avaliações que entraram na Central pela primeira vez. */
  novas: number;
  /** Avaliações que já estavam: a segunda rodada tem de devolver tudo aqui. */
  repetidas: number;
  /** Access token renovado dentro desta rodada. */
  renovados: number;
  /** Organização que nunca autorizou — o Google não foi chamado. */
  semConsentimento: number;
  /** O Google recusou a renovação: a empresa precisa reconectar. */
  reautorizar: number;
  /** A instalação não tem o par OAuth do Perfil da Empresa. */
  semCredencial: number;
  /** Canal sem conta/local gravados: não há o que pedir. */
  semEscopo: number;
  /** O Google recusou a leitura mesmo com token válido (HTTP 401/403). */
  recusadas: number;
  /** A sessão sumiu entre a varredura e a leitura (arquivada no meio). */
  ignoradas: number;
  /** Falhas de infraestrutura: banco, rede fora do Google, exceção. */
  falhas: number;
  /** A rodada parou pelo orçamento de tempo e sobrou canal para a próxima. */
  cortouPorTempo: boolean;
}

export interface OpcoesDaRodada {
  agora: Date;
  /** Injetados para a prova não depender de `process.env`. */
  ambiente?: AmbienteDasAvaliacoes;
  /** `null` = a instalação não tem app OAuth (o teste usa isso). */
  app?: AppDoNegocio | null;
  orcamentoMs?: number;
  tamanhoDaPagina?: number;
  /** Relógio do CORTE POR TEMPO. Injetável: a prova o prende em vez de esperar. */
  relogio?: () => number;
  buscar?: typeof fetch;
  baseDaApi?: string;
  baseDoToken?: string;
}

interface LinhaDeCanal {
  id: string;
  organization_id: string;
  metadata: Record<string, unknown> | null;
}

/** O par OAuth da instalação, lido do ambiente — `null` quando não configurado. */
export function appDoNegocio(ambiente: AmbienteDasAvaliacoes = env): AppDoNegocio | null {
  const clientId = (ambiente.GOOGLE_BUSINESS_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = (ambiente.GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

const resumoVazio = (): ResumoDaRodadaDeAvaliacoes => ({
  examinadas: 0,
  sincronizadas: 0,
  novas: 0,
  repetidas: 0,
  renovados: 0,
  semConsentimento: 0,
  reautorizar: 0,
  semCredencial: 0,
  semEscopo: 0,
  recusadas: 0,
  ignoradas: 0,
  falhas: 0,
  cortouPorTempo: false,
});

/**
 * A rodada. Exportada porque a prova a dirige direto, com banco e `fetch`
 * dublados — mesma disciplina de `renovarAgendasDoGoogle`.
 */
export async function rodadaDasAvaliacoesDoGoogle(
  admin: ReturnType<typeof createAdminClient>,
  opcoes: OpcoesDaRodada,
): Promise<ResumoDaRodadaDeAvaliacoes> {
  const resumo = resumoVazio();
  const ambiente = opcoes.ambiente ?? env;
  const app = opcoes.app === undefined ? appDoNegocio(ambiente) : opcoes.app;
  const orcamento = Math.max(1, opcoes.orcamentoMs ?? ORCAMENTO_MS);
  const tamanho = Math.max(1, opcoes.tamanhoDaPagina ?? TAMANHO_DA_PAGINA_DE_CANAIS);
  const relogio = opcoes.relogio ?? Date.now;
  const inicio = relogio();

  if (!app) {
    // Sem app OAuth não há consentimento possível: uma leitura e nada mais, e a
    // tela do módulo já explica o que falta (`oQueFaltaParaLerAvaliacoes`).
    resumo.semCredencial = 1;
    return resumo;
  }

  let deslocamento = 0;
  let acabou = false;
  while (!acabou) {
    const { data, error } = await admin
      .from("channel_sessions")
      .select("id, organization_id, metadata")
      .eq("provider", "google_business")
      .is("archived_at", null)
      .order("id", { ascending: true })
      .range(deslocamento, deslocamento + tamanho - 1);

    if (error) {
      resumo.falhas += 1;
      break;
    }

    const pagina = (data ?? []) as unknown as LinhaDeCanal[];
    // Página incompleta é a última: o PostgREST não devolve `count` sem pedir, e
    // uma leitura a mais por rodada custaria uma consulta para descobrir o fim.
    if (pagina.length < tamanho) acabou = true;

    for (const canal of pagina) {
      if (relogio() - inicio >= orcamento) {
        resumo.cortouPorTempo = true;
        break;
      }

      resumo.examinadas += 1;
      const organizationId = canal.organization_id;

      const acesso = await tokenDaOrganizacao(admin, organizationId, {
        app,
        agora: opcoes.agora,
        buscar: opcoes.buscar,
        base: opcoes.baseDoToken,
      });

      if (!acesso.ok) {
        if (acesso.motivo === "sem_consentimento") {
          resumo.semConsentimento += 1;
          logger.info("avaliacoes.google.sem_consentimento", {
            organization_id: organizationId,
            channel_session_id: canal.id,
          });
        } else if (acesso.motivo === "sem_credencial") {
          resumo.semCredencial += 1;
        } else if (acesso.motivo === "reautorizar") {
          resumo.reautorizar += 1;
          logger.warn("avaliacoes.google.reautorizar", {
            organization_id: organizationId,
            motivo: acesso.detalhe,
          });
        } else {
          resumo.falhas += 1;
          logger.warn("avaliacoes.google.renovacao_falhou", {
            organization_id: organizationId,
            motivo: acesso.detalhe,
          });
        }
        // Nenhuma chamada ao Google saiu para esta organização.
        continue;
      }

      if (acesso.renovado) resumo.renovados += 1;

      try {
        const resultado = await sincronizarAvaliacoes(admin, {
          organizationId,
          channelSessionId: canal.id,
          ambiente,
          token: acesso.token,
          buscar: opcoes.buscar,
          base: opcoes.baseDaApi,
        });

        if (resultado.status === "sincronizado") {
          resumo.sincronizadas += 1;
          resumo.novas += resultado.novas;
          resumo.repetidas += resultado.repetidas;
        } else if (resultado.status === "canal_sem_escopo") {
          resumo.semEscopo += 1;
        } else if (resultado.status === "canal_ausente") {
          resumo.ignoradas += 1;
        } else if (resultado.status === "sem_credencial") {
          resumo.semCredencial += 1;
        } else {
          // `credencial_recusada`: token válido que o Google recusou. Não rebaixa
          // o consentimento — pode ser escopo retirado no painel do Google — mas
          // deixa o motivo no log com o status.
          resumo.recusadas += 1;
          logger.warn("avaliacoes.google.credencial_recusada", {
            organization_id: organizationId,
            codigo: resultado.codigo,
            motivo: resultado.motivo,
          });
        }
      } catch (erro) {
        // Uma organização com problema não pode deixar as outras sem sincronizar.
        resumo.falhas += 1;
        logger.warn("avaliacoes.google.sincronizacao_falhou", {
          organization_id: organizationId,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      }
    }

    if (resumo.cortouPorTempo) break;
    deslocamento += tamanho;
  }

  // Só audita rodada que mudou alguma coisa (cron-audita-so-quando-ha-efeito).
  const efeito = resumo.sincronizadas + resumo.novas;
  if (efeito > 0) {
    await audit({
      action: "avaliacoes.google.rodada",
      actorUserId: null,
      bypassedRls: true,
      resourceType: "avaliacoes_do_google",
      metadata: {
        examinadas: resumo.examinadas,
        sincronizadas: resumo.sincronizadas,
        novas: resumo.novas,
        repetidas: resumo.repetidas,
        renovados: resumo.renovados,
      },
    });
  }

  return resumo;
}

async function handle(req: NextRequest) {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  if (await recursoOcioso("avaliacoes_do_google")) return ok({ pulado: "recurso_ocioso" }, { requestId });
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "google_business"))) return ok({ pulado: "modulo_desligado" }, { requestId });
  const resumo = await rodadaDasAvaliacoesDoGoogle(admin, { agora: new Date() });
  return ok(resumo, { requestId });
}

export const GET = handle;
export const POST = handle;
