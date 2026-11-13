-- manifest: Cria `google_business_consentimentos` — o consentimento do Perfil da Empresa POR ORGANIZAÇÃO, com refresh token cifrado (`fn_encrypt_oauth`, o mesmo dos outros segredos), escopo concedido, validade do access token e o motivo da última recusa. Sem ela a sincronização periódica não tem com que autenticar: o app OAuth é da instalação, mas o acesso é de cada empresa, e guardar um token por instalação faria a segunda empresa ler as avaliações da primeira. Uma linha por organização (índice único), RLS ligada e nenhum privilégio para anon/authenticated — a tabela é server-side, como as credenciais de MCP. Sem coluna nova em tabela existente e sem função nova (o `updated_at` usa `fn_set_updated_at`). Idempotente (`create table if not exists`).
-- #3510, fase 2 — as avaliações do Google passam a ser buscadas por cron, e o
-- consentimento passa a ser de CADA empresa.
--
-- ─── O que existia, e por que não servia ───────────────────────────────────
--
-- A instalação tem o app OAuth (`platform_google_oauth` e o par
-- `GOOGLE_BUSINESS_OAUTH_CLIENT_ID`/`_SECRET` no `.env`). O app é de quem
-- instalou; o ACESSO é da empresa que autorizou as avaliações do próprio
-- negócio. Sem uma linha por organização, a varredura periódica só teria duas
-- saídas: não autenticar ninguém, ou autenticar todo mundo com o token de uma
-- empresa — a segunda é vazamento entre tenants.
--
-- ─── Por que os tokens são cifrados e a tabela é server-side ───────────────
--
-- Mesma régua de `tenant_integrations` e `contato_mcp_credenciais`: o refresh
-- token nunca é devolvido por leitura de API nenhuma, e a cifra é a da
-- instalação (`fn_encrypt_oauth`, GUC da chave mestra). Com RLS ligada e sem
-- policy, nem `anon` nem `authenticated` leem a tabela — só o service role, que
-- é quem roda o cron.
--
-- ─── O que a recusa grava, e o que ela NÃO pode apagar ────────────────────
--
-- `status = 'reautorizar'` + `ultimo_erro` é o registro de que o Google
-- recusou a renovação. A linha CONTINUA: apagá-la deixaria a empresa sem
-- histórico de que autorizou e sem o motivo visível para quem for reconectar.
-- Falha transitória (rede, 5xx) escreve só `ultimo_erro` e mantém o status.
create table if not exists public.google_business_consentimentos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Cifrado por `fn_encrypt_oauth`; nunca em claro, nem em log, nem em auditoria.
  refresh_token_encrypted text,
  access_token_encrypted text,
  -- O `scope` que o Google concedeu. Vazio = ainda não sabemos; a leitura exige
  -- `business.manage` e a renovação preserva o que já estava gravado.
  escopos text[] not null default '{}'::text[],
  -- Validade do ACCESS token. É o que a rodada lê para renovar ANTES de expirar.
  expira_em timestamptz,
  status text not null default 'ativo',
  -- O motivo da última recusa, para a tela dizer "reconecte" com o porquê.
  ultimo_erro text,
  autorizado_em timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_business_consentimentos_status_check
    check (status in ('ativo', 'reautorizar')),
  constraint google_business_consentimentos_token_check
    -- Linha sem refresh token não renova nada; o caminho de entrada
    -- (`registrarConsentimento`) recusa gravar consentimento sem ele.
    check (refresh_token_encrypted is not null or status = 'reautorizar')
);

-- Uma empresa autoriza UMA vez. O upsert por `organization_id` do código conta
-- com este índice para trocar o token em vez de acumular linhas.
create unique index if not exists google_business_consentimentos_org_uk
  on public.google_business_consentimentos (organization_id);

-- A varredura de renovação ordena por vencimento (mesma forma do índice da
-- agenda). Parcial: linha em `reautorizar` não renova e não precisa entrar.
create index if not exists google_business_consentimentos_renovacao_idx
  on public.google_business_consentimentos (expira_em)
  where status = 'ativo';

comment on table public.google_business_consentimentos is
  'Consentimento do Perfil da Empresa do Google POR ORGANIZAÇÃO (#3510): refresh token cifrado, escopo concedido e validade do access token. Server-side only: RLS ligada sem policy e nenhum privilégio para anon/authenticated. A recusa do Google vira status = reautorizar + ultimo_erro, nunca exclusão da linha.';

alter table public.google_business_consentimentos enable row level security;

revoke all on public.google_business_consentimentos from anon, authenticated;
grant select, insert, update, delete on public.google_business_consentimentos to service_role;

drop trigger if exists trg_google_business_consentimentos_updated_at on public.google_business_consentimentos;
create trigger trg_google_business_consentimentos_updated_at
  before update on public.google_business_consentimentos
  for each row execute function public.fn_set_updated_at();
