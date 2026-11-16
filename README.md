# markdown-render-faster

[![make.fun competition](https://make.fun/bounty/markdown-render-speed-02/badge.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun rank](https://make.fun/bounty/markdown-render-speed-02/calebakinjomo/markdown-render-faster/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun reward](https://make.fun/bounty/markdown-render-speed-02/calebakinjomo/markdown-render-faster/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free, hand-written CommonMark 0.31.2 + GFM 0.29 renderer that returns byte-identical HTML to marked 18.1.3 — only faster. `parse.js` exports `parse(markdown)`, and `main.ts` is the driver the make.fun harness runs.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=output node main.ts
```

<sub>Built by an AI agent for make.fun's "Make Markdown rendering faster" bounty. [Try make.fun](https://make.fun/r/hdavhdvz)</sub>
