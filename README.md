SIGame (trivia game) client running in web, on desktop and in Steam (with the help of Tauri).

Available clients can be found here: https://vladimirkhil.com/si/game

For compilation and running you need Node.js version 18.15.0 or higher.

Used technologies: Typescript, Webpack (with loaders and plugins), React, Redux, Redux Thunk, SignalR, TSLint, Jest, Tauri.

Run:

```
npm install
npm run start
```

The development server will automatically open your browser to `http://localhost:8080`.

Build:

```
npm install
npm run build-prod
```

# Running your own game server (LAN play)

The repository includes a self-contained game server (Node.js only, no extra
dependencies) that hosts both the web client and the game API, so players do not
need internet access or any external server:

```
npm install
npm run build-prod
npm run server
```

The console prints the addresses to share, e.g. `http://192.168.1.42:8080/`.
Players open that address in a browser, the host uploads a `.siq` package and
starts the game; questions and their images, audio and video are downloaded from
the same server, and a question does not start until every player has reported
its media as loaded.

See [server/README.md](server/README.md) for options, the HTTP API, the media
synchronisation details and troubleshooting.

# Testing

SIOnline includes multiple testing approaches:

## Unit Tests
Run Jest unit tests for components and logic:
```bash
npm test
```

## End-to-End Tests
Run Playwright E2E tests for complete user flows:
```bash
# Run all E2E tests
npm run test:e2e

# Run in UI mode (interactive) - REQUIRES display/X Server
# Only works on local machines with graphical display
npm run test:e2e:ui

# Run in debug mode (step-through)
npm run test:e2e:debug
```

**Note**: The UI mode (`test:e2e:ui`) requires a graphical environment and will not work in headless environments like CI pipelines or GitHub Codespaces. Use `npm run test:e2e` instead in those environments.

## Integration Test
Comprehensive game flow test without UI (connects to live server).

**Disabled by default** - only runs when explicitly enabled during manual development:
```bash
RUN_INTEGRATION_TEST=1 npm run test GameIntegration.test.ts
```

See [test/GAME_INTEGRATION_TEST.md](test/GAME_INTEGRATION_TEST.md) for details.

## Manual Testing
For detailed instructions on visual testing with UI, see [TESTING.md](./TESTING.md).

## Mock Service Worker (MSW)
API mocking for testing without a live server. See [docs/TESTING_WITH_MSW.md](docs/TESTING_WITH_MSW.md) for details.

# Desktop build

tauri/src-tauri/tauri.conf.json:

"beforeBuildCommand": "npm run build",
"frontendDist": "../dist"

tauri/vite.config.ts:

comment out: root: '../dist'

# Steam build

tauri/src-tauri/tauri.conf.json:

"beforeBuildCommand": "",
"frontendDist": "../../dist"

tauri/vite.config.ts:

uncomment: root: '../dist'

Set new version in Cargo.toml and tauri.conf.json

run:
npm run build-prod
tauri/build-steam.ps1