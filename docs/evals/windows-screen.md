# Windows screen eval

Run the Windows cases with Rakazo's product eval runner.

```sh
pnpm test:evals --suite windows-screen --list
pnpm test:evals --suite windows-screen --live --trials 1 \
  --connection /path/to/model-connection.json \
  --pricing /path/to/model-pricing.json \
  --output test-report/evals/windows-screen.json
```

Live runs use Docker for a disposable database. The connection file uses the
`models/connect` shape. Use a model that accepts images. If the bundled catalog
predates the model, an OpenAI-compatible connection can set
`"supportsImages": true` for that model. The pricing file uses the standard eval
rates in USD per million tokens.

Each trial uses a fresh workbench behind the paired-computer gateway. The
Windows driver is simulated. Rakazo handles the chat, runs the tools, and
records model usage through the normal product path. The three form cases
check the exact summary and assignee saved by the app. The inspection case
also checks a code shown only in the screenshot. Each trial's
`evidence.userComputer` records paired desktop calls and screenshots.

For a before-and-after run, carry the same suite to both revisions and use
the same connection, pricing, cases and trial count. The
[original comparison](https://github.com/christso/rakazo/blob/f40157a0ca237f030f9723a3b0f373ede0220456/packages/adapters/evals/windows-screen/README.md#results)
records the token and screenshot results for the Windows automation changes.
