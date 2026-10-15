# Generated client SDK

The default and `v2` exports provide the checked-in OpenScience client contracts and types used by existing consumers. Importing them does not include a process launcher. Autofold's research HTTP API uses its separate research client in `frontend/workspace/src/research/client.ts`.

Historical process startup is available only through `@synsci/sdk/legacy`, `@synsci/sdk/legacy/server` and their `legacy/v2` counterparts. These require an independently installed executable implementing the original `openscience serve` protocol. They do not start the Autofold research server.

`npm run build` compiles the existing contracts without launching a server or regenerating them. Run the Autofold backend through the repository's `dev:backend` script.
