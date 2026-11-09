import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { allTools } from "@/lib/mcp/tools";
import { actionSchema } from "@/lib/schemas/webhooks";

const SETOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("RED #3881 — como a IA define o setor HOJE", () => {
  it("nenhuma ferramenta MCP escreve o setor da conversa", () => {
    const nomes = allTools.map((t) => t.name);
    console.log("FERRAMENTAS:", nomes.join(","));
    expect(nomes).not.toContain("crm_set_conversation_sector");
    // A única que mexe em conversa é a de responsável, e ela não tem campo de setor.
    const atribuir = allTools.find((t) => t.name === "crm_assign_conversation");
    console.log("INPUT assign:", JSON.stringify(Object.keys(atribuir!.inputSchema)));
    expect(Object.keys(atribuir!.inputSchema)).not.toContain("sector_id");
  });

  it("nenhuma ação de automação grava o setor", () => {
    const r = actionSchema.safeParse({ type: "define_sector", config: { sector_id: SETOR } });
    console.log("define_sector aceito pelo schema?", r.success);
    expect(r.success).toBe(false);
  });

  it("a régua compartilhada não existe: a escrita mora só na rota humana", () => {
    console.log("existe lib/atendimento/setor-da-conversa.ts?", existsSync("lib/atendimento/setor-da-conversa.ts"));
    expect(existsSync("lib/atendimento/setor-da-conversa.ts")).toBe(false);
  });
});
