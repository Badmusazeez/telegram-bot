# Thru Alphanet Deployment Results

Guide followed: [Getting-started-with-Thru-Create-onchain-account](https://github.com/mztacat/Getting-started-with-Thru-Create-onchain-account)

Network RPC: `https://rpc.alphanet.thru.org`  
Explorer: https://scan.thru.org  
CLI: `thru 0.2.38`

## Account

| Field | Value |
|-------|-------|
| Key name | `default` |
| Public key | `tavA0jId5JGEmRH7WF7yBumlpmuSkJn8GpGMSYXFAtD-yS` |

> Private key stays only in `~/.thru/cli/config.yaml` on the machine that created it. Never commit it.

## Program (C hello-world)

| Field | Value |
|-------|-------|
| Project | `thru-projects/my-first-thru-program` |
| Binary size | 138 bytes |
| Seed | `my-first-thru-program-50383` |
| Meta account | `taDbp7zAbRINImo3fb8yYVW8BU5fjXmZLapfdxTQjQHfaN` |
| Program account | `taVXvUEl2V15QhclrFtrCMdVo9PwPmTCdnGV1ei3pnjbRG` |
| Status | `deployed` |

Deploy command used (current CLI):

```bash
thru --json program create my-first-thru-program-50383 \
  build/thruvm/bin/my_first_thru_program_c.bin
```

Note: the guide’s older `thru uploader upload ...` path currently reverts on alphanet; `thru program create` is the working deploy flow.

## Token ($CAT, 6 decimals)

| Field | Value |
|-------|-------|
| Mint | `tawoRb4-Q2nisrnOyaDtRGUKWEK1Yp9PIg-6dKMFkEUCn3` |
| Token account | `takh3bWdbKhrIh8lupnjpx0k5HN8201n1IFBvZ8YfD1VdE` |
| Minted amount | `1000000000` (1,000 CAT) |
| Mint owner program | `taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq` |

## Name service

| Field | Value |
|-------|-------|
| Root | `myroot0474` |
| Registrar | `taYB-gjnnFWCAKgj2L-5WtnbRpddQAa6CUbQ2pQQu0x-9v` |
| Subdomain | `alice` |
| Domain account | `ta3MkcNXqt7fqHFXMEe4j_kX-wX1fDDjnuhaMKPjFV2QFX` |
| Record `url` | `https://thru.org` |
| Record `thru.pubkey` | `tavA0jId5JGEmRH7WF7yBumlpmuSkJn8GpGMSYXFAtD-yS` |
