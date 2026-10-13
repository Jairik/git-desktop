# GitDaemon Web

React + TypeScript + Vite web client for the local `gitdaemon` server (a minimal
local Git GUI — a condensation of GitHub Desktop).

It is a **thin client**: every git operation is an RPC call to the Rust daemon.
The wire contract is [`docs/architecture/server-client.md`](../docs/architecture/server-client.md)
— this client matches it verbatim (`POST /rpc` with `{id,method,params}` →
`{id,ok,result}` / `{id,ok:false,error}`, plus a `GET /ws` WebSocket for
`clone/fetch/push/pull.progress` events).

## Running

```sh
npm install
npm run dev        # dev server (proxies nothing; talks to the daemon directly)
```

The daemon base URL is resolved in this order:

1. `?server=http://host:port` query parameter
2. `window.GITDAEMON_URL`
3. `localStorage.gitdaemon_url`
4. default `http://127.0.0.1:4789`

If the server is unreachable the UI shows a "Cannot reach the git server"
banner with the URL, a retry button, and a field to change the URL. No
component blocks on the connection — views render against whatever data is
already in the store.

## Layout

```
client/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── scripts/
│   └── smoke.tsx          # "server unreachable" render + network smoke test (npm run smoke)
└── src/
    ├── main.tsx           # React root
    ├── App.tsx            # shell: header, banner, sidebar, tabs, active view
    ├── styles.css         # global dark theme (CSS variables)
    ├── api/
    │   ├── client.ts      # base-URL resolution, rpc<T>(), RpcError, typed `methods`
    │   ├── progress.ts    # /ws progress channel (subscribe/onProgress, auto-reconnect)
    │   └── types.ts       # wire types mirroring the contract (camelCase, kind-unions)
    ├── state/
    │   └── store.tsx      # React Context + useReducer store + actions
    └── ui/                # hand-rolled components (no UI kit)
        ├── common.tsx     # Button / TextInput / ConfirmButton / EmptyState / …
        ├── ServerBanner.tsx
        ├── ErrorToasts.tsx
        ├── ProgressBars.tsx
        ├── Sidebar.tsx    # repo list, add local / create / clone
        ├── Toolbar.tsx    # branch chip, ahead/behind, fetch/pull/push
        ├── ChangesTab.tsx # stage/unstage, commit box, discard, diff pane
        ├── HistoryTab.tsx # log.list, log.commit, diff.commit, undo/reset
        ├── BranchesTab.tsx# branches + remotes sections
        ├── StashTab.tsx
        ├── TagsTab.tsx
        └── DiffPane.tsx   # renders every Diff variant (text/image/binary/…)
```

## Extending

- **New RPC method** → add a typed wrapper to `methods` in `src/api/client.ts`
  (that object is the single place method names live) and call it from a store
  action or a view.
- **New view** → add a tab to `<Tabs/>` + a case in `<ActiveView/>` in
  `src/App.tsx`, and a `src/ui/<Name>Tab.tsx` component reading `useStore()`.
- **Mutating operations** must go through `actions.runMutation(label, fn,
  progressEvent?)` (or a dedicated store action) so the repo data is refreshed
  afterwards — matching the contract's "re-issue status.get / log.list /
  branch.list after any mutation" client behavior.

## Verification

```sh
npx tsc --noEmit   # type check
npm run build      # tsc + vite production build
npm run smoke      # server-unreachable smoke test (no daemon needed)
```
