# ip-info

Looks up public IP metadata (country, city, ISP, timezone) via ipapi.co.

## Usage

```bash
ip-info                       # caller's public IP
ip-info --ip 8.8.8.8          # specific IP
```

## Network policy

Only `ipapi.co` is whitelisted in `tool.yaml`. The loader is expected to
deny any `ctx.fetch()` call to other hosts.
