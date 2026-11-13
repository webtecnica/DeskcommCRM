import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async () => "enc",
  decryptWebhookSecret: async () => "key",
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  CHAVE_DO_MODULO,
  MODULOS_AINDA_NAO_LIGAVEIS,
  MODULOS_OPCIONAIS,
  MODULOS_OPCIONAIS_POR_FLAG,
  moduloLigado,
  modulosLigados,
} from "@/lib/instalacao/modulos";
import { moduloDoCanal, redeSocial } from "@/lib/channels/social/catalog";
import { SocialError } from "@/lib/channels/social/client";
import { garantirModuloDoCanal } from "@/lib/channels/social/store";

/**
 * O MÓDULO DO GOOGLE BUSINESS NASCE DESLIGADO (#3510, retomada do #3637).
 *
 * ─── O que NÃO é o liga/desliga ────────────────────────────────────────────
 *
 * `inbox: false` no catálogo parece o jeito óbvio de "desligar por padrão" e é
 * o errado: esse campo alimenta `CANAIS_DE_CONVERSA`, de onde sai o vocabulário
 * de `conversations.channel`. Desligar a rede ali tiraria `googlebusiness` do
 * vocabulário do banco e o INSERT da avaliação deixaria de ser tipável — o
 * oposto do que a fatia precisa.
 *
 * O desligamento mora na chave do módulo, e o padrão é a AUSÊNCIA da linha:
 * a leitura só liga com `valor === "ligado"`. Este arquivo mede isso, e mede o
 * gate no ponto que cria a sessão do canal (`garantirModuloDoCanal`).
 */

type Resposta = { data?: unknown; error?: unknown } | Error;

/**
 * O dublê de banco do módulo: um builder por tabela, chamável tanto como
 * `.select().in()` (flag em `platform_config`) quanto como
 * `.select().in().eq()` (módulo de tabela) — o mesmo desenho de
 * `lib/instalacao/modulos.test.ts`, para os dois lados medirem a mesma coisa.
 */
function banco(porTabela: Record<string, Resposta> = {}) {
  const from = vi.fn((table: string) => {
    const resposta = porTabela[table] ?? { data: [], error: null };
    const resolver = () =>
      resposta instanceof Error
        ? Promise.reject(resposta)
        : Promise.resolve({ data: resposta.data ?? null, error: resposta.error ?? null });
    const builder = {
      select: () => builder,
      in: () => builder,
      eq: () => builder,
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        resolver().then(onFulfilled, onRejected),
    };
    return builder;
  });
  return { db: { from } as unknown as SupabaseClient };
}

describe("módulo `google_business`: declarado e DESLIGADO por padrão", () => {
  it("entra em MODULOS_OPCIONAIS e na lista por FLAG (é ligável pela tela)", () => {
    expect(MODULOS_OPCIONAIS).toContain("google_business");
    expect(MODULOS_OPCIONAIS_POR_FLAG).toContain("google_business");
    // Se fosse "ainda não ligável", a tela não ofereceria o interruptor e o
    // módulo com padrão desligado ficaria inalcançável sem SQL.
    expect(MODULOS_AINDA_NAO_LIGAVEIS).not.toContain("google_business");
  });

  it("a chave de `platform_config` tem nome próprio", () => {
    expect(CHAVE_DO_MODULO.google_business).toBe("MODULO_GOOGLE_BUSINESS");
  });

  it("sem linha no banco, ele NÃO está ligado — o padrão é a ausência", async () => {
    expect(await moduloLigado(banco().db, "google_business")).toBe(false);
    expect(await modulosLigados(banco().db)).not.toContain("google_business");
  });

  it("só `ligado` liga — `desligado`, `true` e lixo não", async () => {
    const comValor = (valor: string) =>
      banco({
        platform_config: { data: [{ chave: "MODULO_GOOGLE_BUSINESS", valor }] },
      }).db;

    expect(await moduloLigado(comValor("ligado"), "google_business")).toBe(true);
    expect(await moduloLigado(comValor("desligado"), "google_business")).toBe(false);
    expect(await moduloLigado(comValor("true"), "google_business")).toBe(false);
    expect(await moduloLigado(comValor(""), "google_business")).toBe(false);
  });

  it("ligar o Google não liga nenhum outro módulo", async () => {
    const db = banco({
      platform_config: { data: [{ chave: "MODULO_GOOGLE_BUSINESS", valor: "ligado" }] },
    }).db;
    expect(await modulosLigados(db)).toEqual(["google_business"]);
  });
});

describe("quem depende do módulo: a rede → a chave", () => {
  it("o Google é a rede mapeada; as outras não dependem de chave nenhuma", () => {
    expect(moduloDoCanal("googlebusiness")).toBe("google_business");
    for (const rede of ["instagram", "facebook", "telegram"]) {
      expect(moduloDoCanal(rede), `rede ${rede} não devia exigir módulo`).toBeNull();
    }
  });

  it("a rede continua declarada como INBOX — o vocabulário do banco não muda", () => {
    // A armadilha: "desligar" com `inbox: false` derrubaria
    // `CANAIS_DE_CONVERSA` e o INSERT da avaliação perderia o tipo.
    expect(redeSocial("googlebusiness")?.inbox).toBe(true);
  });
});

describe("gate na criação da sessão do canal", () => {
  it("desligado, RECUSA com o motivo — e não cria sessão nenhuma", async () => {
    const erro = await garantirModuloDoCanal(banco().db, "googlebusiness").then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(SocialError);
    expect((erro as SocialError).status).toBe(422);
    expect((erro as SocialError).message).toMatch(/desligado nesta instalação/);
  });

  it("ligado, passa", async () => {
    const db = banco({
      platform_config: { data: [{ chave: "MODULO_GOOGLE_BUSINESS", valor: "ligado" }] },
    }).db;
    await expect(garantirModuloDoCanal(db, "googlebusiness")).resolves.toBeUndefined();
  });

  it("rede sem módulo passa direto, sem consultar o banco", async () => {
    const from = vi.fn();
    const db = { from } as unknown as SupabaseClient;
    await expect(garantirModuloDoCanal(db, "instagram")).resolves.toBeUndefined();
    expect(from).not.toHaveBeenCalled();
  });
});
