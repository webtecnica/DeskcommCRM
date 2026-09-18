---
impacto: nada_mudou
secao: alterado
titulo: As rotas de cron passam a conferir o segredo num portão único, em tempo constante
---

As 26 rotas de `/api/v1/cron/` conferem o segredo por uma única função
compartilhada (`lib/auth/cron-auth.ts`), em vez de cada rota manter a própria
cópia da checagem. Havia quatro formatos diferentes convivendo, e foi uma dessas
cópias que envelheceu sozinha e derrubou a sincronização do catálogo de modelos
com 401.

A comparação do segredo passa a ser em tempo constante. O cabeçalho
`x-cron-secret` continua aceito como alternativa ao `Authorization: Bearer`, como
já era nas rotas que usavam o portão. O agendador não muda: segue mandando
`Bearer` com o segredo do `.env`, e o que respondia passa a responder igual.

Não há ação para quem opera a VPS.
