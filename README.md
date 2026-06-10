# 🔭 Scout

Self-healing browser QA. Cenários escritos em **linguagem natural**, verificados por um **agente AI** num browser real (Playwright), e gravados como **script determinístico** que roda barato e rápido em CI — o AI só volta quando o script quebra.

> Status: POC funcional.

## Por que não só Playwright? Por que não só AI?

| | Playwright puro | AI puro | Scout (híbrido) |
|---|---|---|---|
| Autoria | cara (código + seletores) | barata (1 frase) | barata (1 frase) |
| Custo por run em CI | ~zero | $$ + lento | ~zero (replay) |
| Resiliência a mudança de UI | quebra | se adapta | quebra → AI re-verifica e re-grava |
| Julga comportamento ("paywall NÃO deve aparecer") | só o que foi codado | sim | sim |

**Ciclo de vida de um cenário:**

```
scout create "Paywall free" -c "Abrir ep 3 da série X sem login; paywall deve aparecer com CTA de cadastro"
        │
        ▼
scout go  ──── 1º run: agente AI executa no browser, julga (verified/failed/partial/blocked)
        │       e grava .scout/scripts/paywall-free.json (steps determinísticos + asserções)
        ▼
CI / runs seguintes: replay Playwright puro, sem LLM, segundos por cenário
        │
        ▼
UI mudou e o replay quebrou? ── AI re-executa, re-julga, re-grava o script (self-healing)
                                (`--no-heal` desliga isso, ex: em CI sem API key)
```

## Quickstart

```bash
npm install @pcamarajr/scout       # ou npm link durante o POC
npx playwright install chromium    # browser engine

scout init                         # cria scout.config.json + .scout/
scout create "Login com Google" \
  -c "Na home logged-out, clicar Entrar; página de login deve mostrar opção Google e e-mail/senha" \
  -p anon
scout go                           # 1º run = AI (precisa de credencial Anthropic)
scout go                           # runs seguintes = replay determinístico
scout report                       # markdown pronto pra colar no corpo do PR
```

### Credenciais do AI runner

- **Local:** se você usa Claude Code, o Agent SDK reaproveita as credenciais da sua máquina — zero config.
- **CI/headless:** exporte `ANTHROPIC_API_KEY`. O SDK é self-contained (não precisa do Claude Code CLI instalado).
- Replay determinístico **não usa LLM** — em CI sem key, use `scout go --no-heal` (falha vira ❌ no report em vez de heal).

## Profiles de auth (storageState)

Fluxos autenticados usam sessões capturadas uma vez por ambiente:

```jsonc
// scout.config.json
{
  "baseUrl": "http://localhost:3000",
  "model": "claude-sonnet-4-6",
  "profiles": {
    "anon": { "description": "Sessão logged-out" },
    "assinante": { "description": "Usuário com assinatura ativa", "env": ["QA_SUB_EMAIL", "QA_SUB_PASSWORD"] },
    "free-sem-coins": { "description": "Free sem saldo de coins" }
  }
}
```

```bash
scout login assinante   # abre browser headed, você loga, Enter → salva .scout/state/assinante.json (gitignored)
```

Em CI, gere o storageState num step de setup (login via script) ou deixe o agente logar usando `$ENV:QA_SUB_EMAIL` / `$ENV:QA_SUB_PASSWORD` — placeholders são resolvidos do ambiente em runtime; **segredos nunca entram no script commitado nem passam pelo LLM**.

## Worktrees e ambientes

Tudo é relativo ao diretório do projeto e o alvo vem de env — duas worktrees rodam em paralelo sem colidir:

```bash
SCOUT_BASE_URL=http://localhost:3001 scout go     # worktree B apontando pra outra porta
SCOUT_BASE_URL=https://staging.meuapp.com scout go --no-heal   # contra staging
```

- `.scout/scenarios.json` e `.scout/scripts/` são **commitados** — a suíte viaja com a branch.
- `.scout/runs/` e `.scout/state/` são **gitignored** — artifacts e sessões são por-máquina.

## Artifacts por run

Cada execução grava em `.scout/runs/<timestamp>-<slug>/`:

| Arquivo | O quê |
|---|---|
| `trace.zip` | Playwright trace — screenshots, DOM snapshots, network, console (`npx playwright show-trace trace.zip`) |
| `*.png` | Screenshots de evidência (capturados pelo agente ou no fim do replay/falha) |
| `report.md` | Veredito + razão + script gravado + evidências |
| `result.json` | Resultado estruturado (consumível por automação) |
| `transcript.md` | Raciocínio do agente (só em runs AI) |

## MCP — uso por agentes de código (Claude Code, cloud sessions)

O fluxo principal do Scout é ser chamado **pelo agente que desenvolveu a feature**: o agente escreve o cenário (em NL — nunca o script; o script nasce da execução verificada) e dispara a verificação.

```jsonc
// .mcp.json do projeto alvo
{
  "mcpServers": {
    "scout": { "command": "npx", "args": ["scout", "mcp"] }
  }
}
```

Tools expostas: `scout_list_scenarios`, `scout_create_scenario`, `scout_run`, `scout_report`, `scout_get_run_report`.

## CI (GitHub Actions)

```yaml
qa-browser:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 24 }
    - run: npm ci && npx playwright install --with-deps chromium
    - run: npm run start:test-server &        # app no ar
    - run: npx scout go --no-heal             # replay puro, sem LLM, exit 1 se falhar
      env: { SCOUT_BASE_URL: "http://localhost:3000" }
    - run: npx scout report >> "$GITHUB_STEP_SUMMARY"
      if: always()
    - uses: actions/upload-artifact@v4        # traces + screenshots no run da action
      if: always()
      with: { name: scout-runs, path: .scout/runs/ }
```

Variante com heal em CI: adicionar `ANTHROPIC_API_KEY` e trocar pra `npx scout go` — quando a UI muda legitimamente, o job re-grava o script e o diff de `.scout/scripts/` aparece pra commit (ex: via PR bot).

## CLI completa

```
scout init                      # bootstrap no projeto
scout create <nome> -c <cenário> [-p profile] [-n notas]
scout list                      # cenários + status + 📜 se tem script cacheado
scout go [-s id|slug] [--ai] [--no-heal] [--headed]
scout report                    # resumo markdown da suíte
scout login <profile>           # captura storageState em browser headed
scout mcp                       # MCP server stdio
```

## Vereditos

| | Significado |
|---|---|
| ✅ `verified` | Todo comportamento esperado confirmado por asserções |
| ❌ `failed` | Comportamento quebrado (a razão diz exatamente o quê) |
| ⚠️ `partial` | Parte verificada, parte não |
| 🚫 `blocked` | Não chegou ao fluxo (app fora, login quebrado) |

## Arquitetura

```
src/
├── cli.ts                  # commander CLI
├── engine.ts               # orquestra: replay → (falhou?) → AI heal → re-grava
├── config.ts               # scout.config.json + overrides por env
├── store.ts                # .scout/ (cenários, scripts, runs)
├── report.ts               # markdown por run + resumo de suíte
├── runner/
│   ├── browser.ts          # wrapper Playwright: snapshot com refs, trace, screenshots,
│   │                       #   resolução ref→locator (getByRole quando único, CSS fallback)
│   ├── ai-runner.ts        # Claude Agent SDK + tools de browser in-process; grava steps
│   └── script-runner.ts    # replay determinístico dos steps
└── mcp/server.ts           # interface MCP (stdio)
```

Decisões de design:

- **O agente nunca escreve código de teste.** Ele age no browser; o script é gravado a partir das ações que de fato funcionaram (`getByRole` + nome acessível quando único na página, CSS path como fallback). Elimina seletor alucinado.
- **Asserções são tools.** O agente registra cada expectativa via `browser_assert` — é isso que torna o replay um teste de verdade, não só um macro de cliques.
- **Trace > vídeo.** O trace.zip do Playwright dá screenshots por ação, DOM, network e console num único artifact navegável. Vídeo cru fica como evolução opcional.
- **Sem servidor/dashboard.** Estado é filesystem no repo alvo; report é markdown. Plugável em qualquer projeto com `npm i` + 2 arquivos.

## Limitações conhecidas do POC

- Replay roda sequencial (sem sharding/paralelismo).
- Snapshot cobre elementos interativos + texto; canvas/vídeo são verificados indiretamente (presença do elemento, estado da UI ao redor).
- Fluxos que dependem de ler e-mail não são verificáveis — cobrir UI + redirects.
- Heal re-grava o script localmente; o commit do script atualizado é manual (decisão consciente: diff de script é review-ável).
- Viewport fixo mobile (390×844) — multi-viewport é evolução simples (variante por cenário).
