# Vantage Agent Notes

## Docker Target

Vantage docker work must target the always-on gaming PC only. Same rule as
Atrium: these projects deploy on the PC, not on the default/local docker
context.

- Use the explicit docker context `gamingpc` for all Vantage deploy, compose, image, volume, and container checks.
- Do not use the default docker context for Vantage.
- Do not start or seed a local/default-context Vantage stack.
- Before any docker action, verify the target with `docker context show` or use `docker --context gamingpc ...` directly.

Known correct target:

```bash
docker --context gamingpc ps
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml ps
```

The real dashboard is served from the PC deployment:

```text
https://raghavsgamingpc.tail4d6220.ts.net:3500
```
