import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  adaptadorDaPorta,
  PortaSemTransporteError,
} from "@/lib/channels/social/adaptador-da-porta";
import { redeSocial, SOCIAL_PROVIDER } from "@/lib/channels/social/catalog";
import {
  portaDaRede,
  portaDisponivel,
  PORTAS_SOCIAIS,
  providerNoBancoDaPorta,
} from "@/lib/channels/social/porta";

/**
 * A PORTA PRÓPRIA DO GOOGLE BUSINESS NO CATÁLOGO (#3510, retomada do #3637).
 *
 * ─── O defeito que este arquivo fecha ──────────────────────────────────────
 *
 * A branch do #3637 declarou o Google Business na porta `intermediada`. Trocar
 * para `direta` e parar por aí parece o conserto e é um defeito novo:
 * `providerNoBanco` é propriedade da PORTA, não do par (rede, porta). Com valor
 * em `direta`, Instagram e Facebook — que compartilham a mesma porta —
 * passariam a alegar conexão direta, que não existe para nenhum dos dois.
 *
 * O conserto é o valor POR REDE (`providerNoBancoPorRede`), lido no ponto onde
 * o adapter é montado. Este arquivo mede as duas metades: o Google ganha o
 * valor dele, e as outras redes continuam sem valor nenhum.
 *
 * ─── E o banco? ────────────────────────────────────────────────────────────
 *
 * Porta com transporte precisa de valor no CHECK de `channel_sessions.provider`
 * — e o par banco × TypeScript é cobrado por
 * `tests/invariants/channel-provider-schema.test.ts` (exige Postgres). Aqui se
 * mede o texto do `baseline.sql` e o NÚMERO da migration, que é o que o
 * renumber pode quebrar em silêncio.
 */

const MIGRACOES = "supabase/migrations";
const SUFIXO_DA_MIGRATION = "_avaliacoes_do_google_na_central.sql";

/** A migration desta fatia, achada pelo SUFIXO — o número é o que se quer medir. */
function migrationDaFatia(): { nome: string; numero: string } {
  const achadas = readdirSync(MIGRACOES).filter((nome) => nome.endsWith(SUFIXO_DA_MIGRATION));
  expect(achadas, "a migration desta fatia tem de existir UMA vez").toHaveLength(1);
  const nome = achadas[0]!;
  const numero = /_(\d{4})_/.exec(nome)?.[1];
  expect(numero, `nome de migration fora do padrão NNNN: ${nome}`).toBeTruthy();
  return { nome, numero: numero! };
}

describe("catálogo: o Google Business entra pela porta DIRETA", () => {
  it("declara a porta direta, e ela é a preferida da rede", () => {
    expect(redeSocial("googlebusiness")?.portas).toEqual(["direta"]);
    expect(portaDaRede("googlebusiness").id).toBe("direta");
  });

  it("a direta continua SEM transporte genérico — o valor é da rede, não da porta", () => {
    // Sem esta metade, alguém "conserta" o Google dando provider à porta e
    // entrega conexão direta falsa para Instagram e Facebook.
    expect(PORTAS_SOCIAIS.direta.providerNoBanco).toBeNull();
    expect(PORTAS_SOCIAIS.direta.implementada).toBe(false);
  });

  it("`portaDisponivel` continua dizendo a verdade: não há transporte direto ainda", () => {
    // O valor no banco destrava a LINHA da sessão; o transporte (OAuth + leitura)
    // é a fatia seguinte. `null` aqui é a resposta honesta, e não um erro.
    expect(portaDisponivel("googlebusiness")).toBeNull();
    // A rede que já existia não mudou de porta disponível.
    expect(portaDisponivel("instagram")?.id).toBe("intermediada");
  });
});

describe("providerNoBancoPorRede: o valor é do PAR (rede, porta)", () => {
  it("o Google grava `google_business` na porta direta", () => {
    expect(providerNoBancoDaPorta(PORTAS_SOCIAIS.direta, "googlebusiness")).toBe(
      "google_business",
    );
  });

  it("Instagram e Facebook NÃO herdam o valor do Google na mesma porta", () => {
    // A armadilha medida: sem o mapa por rede, estas duas passariam a alegar
    // conexão direta — e o adapter montaria com um provider que elas não têm.
    expect(providerNoBancoDaPorta(PORTAS_SOCIAIS.direta, "instagram")).toBeNull();
    expect(providerNoBancoDaPorta(PORTAS_SOCIAIS.direta, "facebook")).toBeNull();
  });

  it("a porta intermediada continua sendo a do parceiro, para qualquer rede", () => {
    expect(providerNoBancoDaPorta(PORTAS_SOCIAIS.intermediada, "googlebusiness")).toBe(
      SOCIAL_PROVIDER,
    );
  });
});

describe("adaptadorDaPorta: monta o Google e recusa as outras diretas", () => {
  const credencial = { conta: "locations/123", token: "token" };

  it("monta com o provider do Google — é o que destrava a sessão do canal", () => {
    const adapter = adaptadorDaPorta({
      plataforma: "googlebusiness",
      porta: "direta",
      credencial,
    });
    expect(adapter.provider).toBe("google_business");
  });

  it("Instagram na direta continua RECUSANDO, com o motivo do contrato", () => {
    let erro: unknown;
    try {
      adaptadorDaPorta({ plataforma: "instagram", porta: "direta", credencial });
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(PortaSemTransporteError);
    expect((erro as PortaSemTransporteError).motivo).toBe("sem_provider_no_banco");
  });

  it("o Google não é alcançável pela porta intermediada — a rede não a declara", () => {
    // Dar as duas portas ao Google reabriria o caminho do parceiro que o
    // mantenedor recusou ao fechar o #3637.
    expect(() =>
      adaptadorDaPorta({ plataforma: "googlebusiness", porta: "intermediada", credencial }),
    ).toThrow(/porta_nao_declarada/);
  });
});

describe("banco: o valor do Google existe nos DOIS CHECKs, e o número está colado", () => {
  const baseline = readFileSync("supabase/baseline.sql", "utf8");
  const fatia = migrationDaFatia();
  const migration = readFileSync(`${MIGRACOES}/${fatia.nome}`, "utf8");

  it("`channel_sessions_provider_check` aceita google_business", () => {
    expect(baseline).toMatch(
      /channel_sessions_provider_check[\s\S]{0,700}'google_business'::text/,
    );
  });

  it("`channel_sessions_provider_ref_check` prende o ESCOPO que a leitura usa", () => {
    // O ref desta porta é `metadata.google_business_escopo` — é o que
    // `lerCanalDaAvaliacao` lê. Sem este ramo a sessão passaria sem endereço.
    expect(baseline).toMatch(
      /provider = 'google_business' and metadata \? 'google_business_escopo'/,
    );
  });

  it("os dois CHECKs e o vocabulário da conversa moram na MESMA migration", () => {
    // CHECK em arquivo separado abre janela sem constraint durante o `update.sh`
    // e a cerca `baseline-constraint-reconstruida` reprova.
    expect(migration).toContain("channel_sessions_provider_check");
    expect(migration).toContain("channel_sessions_provider_ref_check");
    expect(migration).toContain("conversations_channel_check");
    expect(migration).toContain("'google_business'::text");
    expect(migration).toContain("'googlebusiness'");
  });

  it("o comentário do baseline cita o NÚMERO da migration que existe no disco", () => {
    // Renumerar só o arquivo (ou só o comentário) é o erro que passa verde:
    // o `git mv` move número e timestamp, e o comentário tem de ir junto.
    expect(baseline).toContain(`(migration ${fatia.numero}, issue #3510)`);
    expect(fatia.numero >= "9364").toBe(true);
  });

  it("o union `ChannelProvider` fala o mesmo vocabulário do CHECK", () => {
    // Espelho local da comparação que o invariante faz contra o Postgres —
    // aqui ela roda sem container e sem a fila do `test:db`.
    const fonte = readFileSync("lib/channels/types.ts", "utf8");
    const decl = /type\s+ChannelProvider\s*=([^;]*);/s.exec(fonte);
    if (!decl) throw new Error("extrator: `type ChannelProvider = …` não encontrado");
    const literais = [...decl[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(literais).toContain("google_business");
  });
});
