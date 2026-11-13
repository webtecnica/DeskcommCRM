-- manifest: Soma 'googlebusiness' ao vocabulário de `conversations_channel_check` e 'google_business' aos DOIS CHECKs de provider de `channel_sessions` (`_provider_check` e `_provider_ref_check`), no bloco único do baseline: sem o primeiro a avaliação do Perfil da Empresa não entra na Central (23514) e sem os outros dois a sessão do canal direto não é persistível — e `ChannelProvider` em `lib/channels/types.ts` tem de falar o mesmo vocabulário, cobrado por `tests/invariants/channel-provider-schema.test.ts`. Os três vocabulários no MESMO arquivo: CHECKs em migrations separadas abrem janela sem constraint durante o `update.sh`. Sem tabela, coluna ou função nova — logo sem grant a acrescentar. Idempotente (drop if exists + add).
-- Avaliações do Google (Perfil da Empresa) entram na Central como conversa, e o
-- canal direto do Google ganha valor no CHECK de `channel_sessions.provider`.
--
-- ─── Por que este arquivo existe ───────────────────────────────────────────
--
-- A fatia 1 da #3510 traz as avaliações do Google para a Inbox reusando
-- `conversations`/`messages` — é o que faz a avaliação aparecer na lista, no
-- detalhe, na busca e nas contagens sem uma segunda tela com as mesmas quatro
-- coisas. Só que `conversations_channel_check` aceita hoje
-- ('whatsapp', 'instagram', 'facebook'): sem somar 'googlebusiness', o primeiro
-- INSERT de avaliação bate 23514 e a sincronização morre verde do lado de fora
-- (o erro é do banco, não da leitura).
--
-- A segunda metade é a PORTA: `lib/channels/social/catalog.ts` declara o Google
-- Business na porta `direta` (conexão com a plataforma da própria rede, sem
-- intermediário — o desenho que o mantenedor pediu ao fechar o #3637). Porta
-- com transporte precisa de valor em `channel_sessions.provider`, e o CHECK não
-- tinha nenhum para ela: a linha da sessão era inexprimível, e é por isso que
-- `adaptador-da-porta.ts` se recusava a montar o adapter. `google_business`
-- entra nos dois CHECKs — o de vocabulário e o que exige a coluna de
-- referência de cada provider.
--
-- ─── Por que o ref do Google é `metadata.google_business_escopo` ──────────
--
-- Não há coluna nova nesta fatia, e não deve haver: a identidade de uma conexão
-- do Google Business é o ESCOPO do Perfil da Empresa (a conta/location que
-- autorizou), e é dele que a leitura das avaliações parte —
-- `lerCanalDaAvaliacao` (`lib/channels/google-business/ingest.ts`) lê
-- exatamente `metadata.google_business_escopo`. Reusar `zernio_account_id` aqui
-- seria mentir: aquela coluna é do intermediário, e esta porta é justamente a
-- que dispensa intermediário. O ramo do CHECK prende o que o código já lê: sem
-- escopo gravado, a sessão não passa — o mesmo contrato dos outros providers,
-- que exigem a coluna que os endereça.
--
-- ─── Sem tabela nova, e por isso sem grants ───────────────────────────────
--
-- Nenhuma tabela, coluna ou função nasce aqui: a avaliação usa
-- `conversations.metadata` (nota, escopo, respondida) e `messages.metadata`.
-- Logo não há `grant`/`revoke` a acrescentar, e o bloco da VARREDURA anon não é
-- tocado — a doutrina do baseline vale para objeto NOVO.
--
-- ─── Uma constraint, um bloco ─────────────────────────────────────────────
--
-- Os três vocabulários vivem num bloco ÚNICO cada no `baseline.sql`,
-- atualizado no mesmo commit desta migration: dois drop+add da MESMA constraint
-- abrem duas janelas sem CHECK durante o `update.sh` e o último a rodar decide
-- o vocabulário — é a razão da cerca
-- `tests/unit/baseline-constraint-reconstruida.test.ts`. E os dois CHECKs de
-- `channel_sessions` andam JUNTOS no mesmo arquivo: somar o provider só ao de
-- vocabulário deixaria a sessão passar no primeiro e bater no segundo.
--
-- Idempotente: `drop … if exists` + `add`.

alter table public.conversations drop constraint if exists conversations_channel_check;
alter table public.conversations add constraint conversations_channel_check
  check (channel in ('whatsapp', 'instagram', 'facebook', 'googlebusiness'));

alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'wacalls'::text, 'zernio_social'::text, 'datafy'::text, 'google_business'::text]));

alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check (
  (provider = 'waha' and waha_session_name is not null) or
  (provider = 'meta_cloud' and meta_phone_number_id is not null) or
  (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
  (provider = 'wacalls' and wacalls_session_id is not null) or
  (provider = 'datafy' and datafy_phone_number_id is not null) or
  -- O escopo do Perfil da Empresa é o ref desta porta (ver o cabeçalho).
  (provider = 'google_business' and metadata ? 'google_business_escopo')
);
