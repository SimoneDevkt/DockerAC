# DockerAC

Docker image for running **Assetto Corsa Server Manager** (single or multiserver) with optional
**sTracker**, **Real Penalty** and **KissMyRank** plugins.

The image ships **no licensed software**. On first start a setup page on port `8772` lets you
upload Server Manager, your licence and the plugins; everything is stored in the `./data` volume,
so updating the image never touches your data.

You can choose between:

| Server Manager | AC server | Multiserver | Licence |
|---|---|---|---|
| [Assetto Corsa Server Manager](https://emperorservers.com) (paid) | built in (since v2.0) | ✓ | `ACSM.License` |
| [Assetto Server Manager](https://github.com/JustaPenguin/assetto-server-manager) v1.7.9 (free, archived) | Kunos `acServer` (steamcmd or upload) | ✗ | none, MIT |

## Quick start

```sh
mkdir dockerac && cd dockerac
curl -O https://raw.githubusercontent.com/SimoneDevkt/DockerAC/master/docker-compose.yml
docker compose up -d
docker compose logs assetto   # shows the setup password
```

Open `http://<host>:8772`, log in with the password from the logs (or set `SETUP_PASSWORD` in
`docker-compose.yml`) and follow the steps:

1. **Server Manager**
   - *paid*: upload `acsm_vX.Y.Z_linux-amd64.zip` and `ACSM.License`
     (both from the emperorservers.com control panel), pick single server or multiserver and the
     number of servers;
   - *free*: it's downloaded from GitHub automatically.
2. **Assetto Corsa server**
   - *built into ACSM* (paid only): nothing to do, upload cars and tracks from the Server Manager UI;
   - *steamcmd*: steamcmd is downloaded into the volume and installs app `302550`.
     A dedicated Steam account without Steam Guard is recommended; credentials are not saved;
   - *zip upload* of an existing dedicated server folder;
   - *already present*: if `./data/assetto/acServer` already exists.
3. **Plugins** (optional): upload the zips exactly as downloaded
   ([sTracker](https://www.racedepartment.com/downloads/stracker.3510/),
   [Real Penalty](https://www.racedepartment.com/downloads/real-penalty-tool.29591/),
   [KissMyRank](https://www.racedepartment.com/downloads/kissmyrank-local-assetto-corsa-server-plugin.17667/)).
   The right folder is detected automatically and installed into `data/assetto/<plugin>`
   (sTracker's `stracker_linux_x86.tgz` is extracted too). Configure them afterwards from the
   Server Manager UI.
4. **Install**: the page shows the log, then the container switches to Server Manager on the same
   port and the page reloads. Default Server Manager login: `admin` / `servermanager`.

## Updating Server Manager or adding plugins

Set `SETUP: 1` in `docker-compose.yml` (or create an empty `./data/.reconfigure` file) and
restart the container. Upload only what you want to change: `config.yml`, the database,
content and the licence are kept. Remember to set `SETUP` back to `0` afterwards
(`.reconfigure` is deleted automatically).

## Manual installation (without the setup page)

Copy `server-manager`, `config.yml` (and `ACSM.License`, `assetto-multiserver-manager`,
`servers.yml` for multiserver) into `./data` before the first start: the setup page is skipped
and the mode is detected from the files that are present. `SM_MODE=single|multi` forces the mode.

## Layout of `./data`

```
data/
├── server-manager, assetto-multiserver-manager
├── ACSM.License, config.yml, servers.yml
├── server_manager.db, servers/, shared_store.json/
├── plugins/            lua plugins
└── assetto/            AC server install path
    ├── stracker/
    ├── realpenalty/
    └── kissmyrank/
```

## Environment variables

| Variable | Default | |
|---|---|---|
| `SETUP_PASSWORD` | random, printed in the logs | setup page password |
| `SETUP` | `0` | `1` forces the setup page at startup |
| `PUID` / `PGID` | `1000` | owner of the files in `./data` |
| `SM_MODE` | from the setup | `single` or `multi`, overrides the installed mode |
| `FREE_SM_URL` | v1.7.9 release | zip of the free Server Manager |

## Ports

The compose file exposes the ports for 5 servers (game `9600-9604` TCP/UDP, HTTP `8081-8085`,
sTracker, Real Penalty, KissMyRank). Set the same ports for each server in the Server Manager
options and adjust the ranges if you use more servers.

## Migrating from the old version (SimView/MySQL)

SimView has been removed. To keep your data, move the old folders into `./data`:
`servermanager/servers` → `data/servers`, `servermanager/shared_store.json` → `data/shared_store.json`,
`conf_servermanager/*` → `data/`, `assetto` → `data/assetto`, and the plugins into
`data/assetto/{stracker,realpenalty,kissmyrank}`. In `config.yml` remove the
`assetto/simview/SimViewWriter` entry under `server.plugins`.

## Image build

GitHub Actions builds `ghcr.io/simonedevkt/dockerac` on every push to `master` (`latest` tag)
and on `v*` tags (semver tags). Local build: `docker compose build`.
