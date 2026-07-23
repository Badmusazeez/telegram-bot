# Thru Alphanet Deployment

Thru L1 (Unto Labs) setup and alphanet deployment, following  
[mztacat/Getting-started-with-Thru-Create-onchain-account](https://github.com/mztacat/Getting-started-with-Thru-Create-onchain-account).

## What’s here

- `scripts/setup-thru.sh` — install CLI, create/fund account, toolchain + C SDK
- `scripts/deploy-thru-program.sh` — build and deploy the sample C program
- `thru-projects/my-first-thru-program` — scaffolded ThruVM C program
- `thru-projects/deployment-results.md` — live alphanet addresses from this run

## Quick start

```bash
# 1) One-time machine setup
./scripts/setup-thru.sh

# 2) Build + deploy sample program
./scripts/deploy-thru-program.sh
```

Or manually (guide steps):

```bash
npm install -g thru@0.2.38
thru --json getversion
thru --json account create default
thru --json faucet withdraw default 10000

mkdir -p thru-projects
thru dev init c my-first-thru-program --path thru-projects
cd thru-projects/my-first-thru-program
export RISCV_TOOLCHAIN_ROOT="$HOME/.thru/sdk/toolchain"
export RISCV_SYSROOT="$HOME/.thru/sdk/toolchain/picolibc/thruvm"
make -j
thru --json program create my-seed build/thruvm/bin/my_first_thru_program_c.bin
```

## This environment’s deployment

| Item | Address / value |
|------|-----------------|
| Account | `tavA0jId5JGEmRH7WF7yBumlpmuSkJn8GpGMSYXFAtD-yS` |
| Program | `taVXvUEl2V15QhclrFtrCMdVo9PwPmTCdnGV1ei3pnjbRG` |
| $CAT mint | `tawoRb4-Q2nisrnOyaDtRGUKWEK1Yp9PIg-6dKMFkEUCn3` |
| Name | `alice.myroot0474` |

Full details: [`thru-projects/deployment-results.md`](thru-projects/deployment-results.md)

## Security

- `~/.thru/cli/config.yaml` stores the **private key in plaintext**
- Never commit that file or paste the key into chat/PRs
- Alphanet faucet tokens have no value; still treat keys like production secrets

## Links

- Guide: https://github.com/mztacat/Getting-started-with-Thru-Create-onchain-account
- Docs: https://docs.thru.org
- Explorer: https://scan.thru.org
- RPC: https://rpc.alphanet.thru.org
