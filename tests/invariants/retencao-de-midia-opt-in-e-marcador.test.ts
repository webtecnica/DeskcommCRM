/**
 * A retenção de mídia é OPT-IN e MARCA a mensagem como expirada (migration 0526).
 *
 * O que a 0432 entregou podava a mídia de QUALQUER organização pela
 * `media_retention_days`, sem ninguém dizer "sim". O issue #1534 exige que:
 *   - uma organização EXISTENTE só começa a expirar depois de LIGAR e confirmar
 *     (`media_retention_enforced`);
 *   - o piso de 30 dias vale MESMO com valor menor gravado no banco;
 *   - a poda é isolada por organização (ligar uma não arrasta a outra);
 *   - a mensagem vencida fica com marcador `metadata.media_status = 'expired'`
 *     e perde tanto `media_storage_path` quanto `media_url` — a rota de mídia
 *     NÃO vai buscar de novo do provedor o que expirou;
 *   - templates e avatares não são tocados (corpo da 0432 preservado);
 *   - organização NOVA nasce com `media_retention_enforced = true` (default).
 */
import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG_SEM_OPTIN = "43700000-0000-4000-8000-000000000001";
const ORG_COM_OPTIN = "43700000-0000-4000-8000-000000000002";
const ORG_NOVA_DEFAULT = "43700000-0000-4000-8000-000000000003";
/**
 * Organizações PRÓPRIAS do terceiro caso. Um arquivo = um banco, então os três
 * casos compartilham a mesma pilha: reusar as das irmãs chocava o
 * `contacts_pkey` (a mesma linha de contato montada duas vezes) e, pior, a de
 * opt-in chegava com a mídia JÁ expirada pela irmã de cima — a medição saía de
 * um estado que este caso não montou. Org nova = fixture limpa = o isolamento
 * mede isolamento, não resíduo.
 */
const ORG_SEM_OPTIN_ISO = "43700000-0000-4000-8000-000000000004";
const ORG_COM_OPTIN_ISO = "43700000-0000-4000-8000-000000000005";

/**
 * Um UUID VÁLIDO derivado do da organização: o 2º grupo vira o rótulo, o
 * último (o da própria org) fica de pé.
 *
 * O defecto era colar `-0000-4000-8000-…` num uuid INTEIRO, virando
 * `43700000-0000-4000-8000-000000000001-0000-4000-8000-0000000000b1` — 45
 * caracteres com dois hífens a mais — e o Postgres recusava todo INSERT com
 * `invalid input syntax for type uuid`. Manter o grupo do fim também é o que
 * impede id de duas organizações diferentes de colidir: sem isto, o isolamento
 * que o terceiro caso mede cairia no conflito de PK antes de chegar nele.
 */
const idDe = (org: string, rotulo: string) => `${org.slice(0, 9)}${rotulo}${org.slice(13)}`;

const naFila = (p: string) =>
  Number(lastLine(sql(`select count(*) from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = '${p}'`)));

/** Fixture de UMA organização: uma mensagem velha (100 dias) e uma nova (5). */
function monta(org: string, optin: string): void {
  const com = `${org}`;
  const conta = idDe(org, "00b1");
  const conv = idDe(org, "00b2");
  const sess = idDe(org, "00b3");
  const velha = idDe(org, "00d1");
  const nova = idDe(org, "00d2");
  const pv = `${com}/v.jpg`;
  const pn = `${com}/n.jpg`;
  sql(`
    insert into storage.buckets (id, name) values ('whatsapp-media', 'whatsapp-media') on conflict (id) do nothing;
    insert into organizations (id, slug, legal_name, display_name, media_retention_days, media_retention_enforced)
      values ('${com}', 'org-${com}', 'Org', 'Org', 10, ${optin})
      on conflict (id) do update set media_retention_days = '10', media_retention_enforced = ${optin};
    insert into contacts (id, organization_id, name, phone_number)
      values ('${conta}', '${com}', 'Cliente', '+5511999900000');
    insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
      values ('${sess}', '${com}', 's-${com}', 'WORKING', '\\\\x00'::bytea);
    insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
      values ('${conv}', '${com}', '${conta}', '${sess}', 'open', false);
    insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                          type, direction, status, sent_via, sent_at, created_at, media_storage_path, media_url)
      values ('${velha}', '${com}', '${conv}', '${sess}', '${conta}', 'image', 'inbound', 'delivered', 'external_device',
              now() - interval '100 days', now() - interval '100 days', '${pv}', 'https://p.t/${pv}'),
             ('${nova}', '${com}', '${conv}', '${sess}', '${conta}', 'image', 'inbound', 'delivered', 'external_device',
              now() - interval '5 days', now() - interval '5 days', '${pn}', 'https://p.t/${pn}');
    insert into storage.objects (bucket_id, name, metadata, created_at) values
      ('whatsapp-media', '${pv}', '{"size": 100}'::jsonb, now() - interval '100 days'),
      ('whatsapp-media', '${pn}', '{"size": 100}'::jsonb, now() - interval '5 days');
  `);
}

const msgStatus = (org: string, qual: "velha" | "nova") => {
  const id = idDe(org, qual === "velha" ? "00d1" : "00d2");
  return lastLine(sql(`select metadata->>'media_status' from messages where id = '${id}'`));
};
const msgCampos = (org: string) => {
  const id = idDe(org, "00d1");
  return lastLine(sql(`select (media_storage_path is null)::text || '|' || (media_url is null)::text from messages where id = '${id}'`));
};

describe("fn_enfileirar_midia_vencida — opt-in, piso, isolamento e marcador (0526)", () => {
  it("sem opt-in nada expira; organizações novas nascem com opt-in", () => {
    monta(ORG_SEM_OPTIN, "false");
    // Organização NOVA: omitir a coluna deve herdar o DEFAULT (true).
    sql(
      `insert into organizations (id, slug, legal_name, display_name, media_retention_days) ` +
        `values ('${ORG_NOVA_DEFAULT}', 'org-nova', 'Org Nova', 'Org Nova', 60);`,
    );
    const r = JSON.parse(lastLine(sql(`select public.fn_enfileirar_midia_vencida(500)::text`)));
    // A organização SEM opt-in não enfileira nada, mesmo com mídia de 100 dias.
    expect(r.vencidas).toBe(0);
    expect(naFila(`${ORG_SEM_OPTIN}/v.jpg`)).toBe(0);
    // Coluna garante que organização nova nasce com a retenção aplicada.
    expect(lastLine(sql(`select media_retention_enforced::text from organizations where id = '${ORG_NOVA_DEFAULT}'`)))
      .toBe("true");
  });

  it("com opt-in expira na 30 (piso) e marca a mensagem expired, anulando storage e url", () => {
    monta(ORG_COM_OPTIN, "true");
    const r = JSON.parse(lastLine(sql(`select public.fn_enfileirar_midia_vencida(500)::text`)));
    // media_retention_days = 10 no banco -> piso 30 -> a de 100 dias entra, a de 5 não.
    expect(r.vencidas).toBe(1);
    expect(naFila(`${ORG_COM_OPTIN}/v.jpg`)).toBe(1);
    expect(naFila(`${ORG_COM_OPTIN}/n.jpg`)).toBe(0);
    // Marcador + os DOIS campos anulados (a rota não busca de novo do provedor).
    expect(msgStatus(ORG_COM_OPTIN, "velha")).toBe("expired");
    expect(msgCampos(ORG_COM_OPTIN)).toBe("true|true");
    expect(msgStatus(ORG_COM_OPTIN, "nova")).toBe(""); // null / sem marcador
  });

  it("isolamento por organização: ligar uma não arrasta a outra", () => {
    monta(ORG_SEM_OPTIN_ISO, "false");
    monta(ORG_COM_OPTIN_ISO, "true");
    const r = JSON.parse(lastLine(sql(`select public.fn_enfileirar_midia_vencida(500)::text`)));
    expect(r.vencidas).toBe(1);
    expect(naFila(`${ORG_SEM_OPTIN_ISO}/v.jpg`)).toBe(0);
    expect(naFila(`${ORG_COM_OPTIN_ISO}/v.jpg`)).toBe(1);
  });
});