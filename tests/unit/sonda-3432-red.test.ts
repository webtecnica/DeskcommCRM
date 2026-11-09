import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SONDA do defeito na `origin/main` (não é o teste que fica): mede, com a
 * assinatura de TRÊS argumentos que existe hoje, os dois lados que a correção
 * do #3432 precisa fechar — o N+1 da pergunta por contato e a ficha já
 * anonimizada que é recriada quando a marca da 0750 não existe.
 */

const estado = vi.hoisted(() => ({
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  existente: null as { id: string; phone_number: string } | null,
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => estado.existente,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
  registrarMensagemIgnorada: async () => undefined,
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: async () => undefined }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: async () => true }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

import { ingestMetaAppContactSync } from "@/lib/channels/meta/ingest";
import type { AppContactSyncEvent } from "@/lib/channels/meta/webhook";

const TELEFONE = "5519999999999";
const OUTRO = "5519988887777";

function evento(phone: string): AppContactSyncEvent {
  return {
    kind: "app_contact_sync",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    phone,
    name: "Ana Souza",
    action: "add",
  };
}

function adminFalso(): SupabaseClient {
  const from = (table: string) => {
    if (table === "channel_sessions") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({
          data: { id: "session-1", organization_id: "org-1" },
          error: null,
        }),
      };
      return chain;
    }
    if (table === "contacts") {
      return {
        update: () => {
          const chain: Record<string, unknown> = {
            eq: () => chain,
            then: (ok: (v: unknown) => unknown) => ok({ data: null, error: null }),
          };
          return chain;
        },
      };
    }
    throw new Error(`tabela inesperada: ${table}`);
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    estado.rpcs.push({ name, args });
    if (name === "fn_titular_apagado_a_pedido") return { data: false, error: null };
    if (name === "fn_upsert_wa_contact") return { data: "contact-novo", error: null };
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const DONO = { organizationId: "org-1" } as never;
const chamadas = (nome: string) => estado.rpcs.filter((r) => r.name === nome);

beforeEach(() => {
  estado.rpcs = [];
  estado.existente = null;
});

describe("sonda na origin/main", () => {
  it("5 contatos custam UMA consulta (hoje: uma POR contato)", async () => {
    const telefones = [TELEFONE, OUTRO, "5519977776666", "5519966665555", "5519955554444"];
    for (const phone of telefones) {
      await ingestMetaAppContactSync(adminFalso(), evento(phone), DONO);
    }

    expect(chamadas("fn_titular_apagado_a_pedido")).toHaveLength(1);
  });

  it("ficha já anonimizada (sem marca da 0750) não volta (hoje: volta)", async () => {
    // O contato anonimizado não é achado pelo número — é o que acontece de
    // verdade, porque a anonimização zera `phone_number`.
    estado.existente = null;

    const r = await ingestMetaAppContactSync(adminFalso(), evento(TELEFONE), DONO);

    expect(chamadas("fn_upsert_wa_contact")).toEqual([]);
    expect(r.status).toBe("ignored");
  });
});
