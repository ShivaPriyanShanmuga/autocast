# web-app fixture

A dependency-free HTTP server used by castscript's browser tests. Never add
npm dependencies — tests must run with no install and no network.

    node fixtures/web-app/server.mjs 3000

| Route | Purpose |
|---|---|
| `GET /` | The order-desk page |
| `GET /api/slow` | Sleeps 500ms, so `wait_for` has something real to wait on |
| `POST /api/orders` | Creates an order, logs `POST /api/orders 201` to stdout |
| `GET /api/orders` | Lists orders |

The page keeps `[data-test=order-form]` small on purpose, so `focus:` zoom
has a worthwhile target.
