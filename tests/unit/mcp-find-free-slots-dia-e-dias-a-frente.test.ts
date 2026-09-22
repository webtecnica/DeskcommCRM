import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type * as AgendaConsulta from "@/lib/agenda/consulta";
import type { ResultadoDaConsulta } from "@/lib/agenda/consulta";
import type { McpContext } from "@/lib/mcp/types";

/**
 * `crm_find_free_slots` recebendo `dia` E `dias_a_frente` na MESMA chamada — a
 * cerca da issue #1436.
 *
 * ## Por que este arquivo existe separado do `mcp-agendamento-tools.test.ts`
 *
 * Porque a convivência dos dois campos era medida LÁ como recusa
 * ("não aceita dia específico e período relativo juntos"): aquele arquivo prova a
 * DECISÃO da 1.20.0, este prova o COMPORTAMENTO pedido na #1436. São medições
 * opostas do mesmo input, e ficam separadas para que a divergência seja visível
 * em vez de escondida no mesmo `describe`.
 *
 * ## O que o modelo faz na prática
 *
 * Ele manda os dois em quase toda chamada. Recusar custava o turno inteiro: lista
 * vazia em <1 ms, sem tocar no banco, o cliente sem resposta, e `success: true`
 * na auditoria. A ferramenta tolera e o `dia` — o mais específico — vence.
 */
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: vi.fn(),
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
}));

vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof AgendaConsulta>();
  return { ...real, horariosLivresDaOrg: vi.fn(), listaAgendamentos: vi.fn(), idDoTipoPorSlug: vi.fn() };
});

const { horariosLivresDaOrg } = await import("@/lib/agenda/consulta");
const { crmFindFreeSlots } = await import("@/lib/mcp/tools/agendamento");

const ctx: McpContext = {
  organizationId: "org-1",
  role: "agent",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "tok-1",
  requestId: "req-1",
  supabase: {} as unknown as SupabaseClient,
};

const SUCESSO: ResultadoDaConsulta = {
  ok: true,
  slots: [{ inicio: new Date("2026-09-13T14:00:00Z"), fim: new Date("2026-09-13T14:30:00Z") }],
  fusoDaRegra: "America/Sao_Paulo",
  publicouHorarios: true,
  fusoSuposto: false,
  fontesDefasadas: [],
  agendaExternaNuncaLida: false,
  googleCoberturaParcial: false,
};

describe("crm_find_free_slots com os dois campos na mesma chamada", () => {
  beforeEach(() => {
    vi.mocked(horariosLivresDaOrg).mockReset();
    vi.mocked(horariosLivresDaOrg).mockResolvedValue(SUCESSO);
  });

  it("devolve HORÁRIOS em vez de recusar", async () => {
    const r = (await crmFindFreeSlots.handler(
      { event_type_slug: "consulta-inicial", dia: "2026-09-13", dias_a_frente: 7 },
      ctx,
    )) as { horarios: { inicio: string }[]; total_de_horarios: number; motivo?: string };

    // A coleta FOI chamada: a recusa antiga saía antes de chegar no banco.
    expect(horariosLivresDaOrg).toHaveBeenCalledTimes(1);
    expect(r.motivo).toBeUndefined();
    expect(r.horarios.map((h) => h.inicio)).toEqual(["2026-09-13T14:00:00.000Z"]);
    expect(r.total_de_horarios).toBe(1);
  });

  it("o `dia` vence o relativo: a janela é a do dia nomeado, não a de agora+7d", async () => {
    await crmFindFreeSlots.handler(
      { event_type_slug: "consulta-inicial", dia: "2026-09-13", dias_a_frente: 7 },
      ctx,
    );

    const params = vi.mocked(horariosLivresDaOrg).mock.calls[0]![2];
    // A faixa larga do dia civil (cobre qualquer fuso) — a MESMA que sai quando
    // `dia` vem sozinho. É isto que prova a precedência, e não só a tolerância.
    expect(params.de.toISOString()).toBe("2026-09-12T10:00:00.000Z");
    expect(params.ate.toISOString()).toBe("2026-09-14T14:00:00.000Z");
  });

  it("`dias_a_frente` sozinho continua funcionando (o caminho relativo não regrediu)", async () => {
    const antes = Date.now();
    await crmFindFreeSlots.handler({ event_type_slug: "consulta-inicial", dias_a_frente: 7 }, ctx);
    const depois = Date.now();

    const params = vi.mocked(horariosLivresDaOrg).mock.calls[0]![2];
    const seteDias = 7 * 86_400_000;
    expect(params.ate.getTime() - params.de.getTime()).toBe(seteDias);
    expect(params.de.getTime()).toBeGreaterThanOrEqual(antes);
    expect(params.de.getTime()).toBeLessThanOrEqual(depois);
  });
});
