Assetto corsa multi-server manager with stracker, realpenalty, kissmyrank and simview plugins with docker and docker compose.

This setup allow you to run on docker a preconfig server manager with 5 server on a single host

# How to use
Download this project

Edit all yml and toml file by changing each password/key line with a stronger password (e.g. mysql password default is 'simviewpw', change this in docker-compose.yml and all toml files)

copy the ac_kissmyrank_linux folder from https://www.racedepartment.com/downloads/kissmyrank-local-assetto-corsa-server-plugin.17667/ to kissmyrank folder

copy the extracted folder from https://www.racedepartment.com/downloads/real-penalty-tool.29591/ to realpenalty folder

copy the extracted folder from https://www.racedepartment.com/downloads/stracker.3510/ to stracker folder and extract twice the stracker_linux_x86.tgz file (on linux `tar xfvz stracker_linux_x86.tgz`) 

copy the SimView-v1.2.1-Linux-x64.zip folder from https://www.racedepartment.com/downloads/simview.35249/ to simview folder

copy the acsm_v2.1.6_linux-amd64.zip folder from https://emperorservers.com/control-panel to servermanager folder

copy the ACSM.License file from https://emperorservers.com/control-panel to conf_servermanager folder


open prompt, go to project folder and run
```
docker compose up -d
```

After this, wait some minutes and go to localhost:8772 and localhost:10100 (change localhost with your ip or domain if you are using a remote server)

On server manager change plugins and server port with this config (it's not mandatory to use this specific port, but you may change .toml file in conf_simview folder)
https://docs.google.com/spreadsheets/d/1RBrfKjMcnvTGKRZwZM2Q_K0to7L6OLk7eCRYsQPyuxU/edit#gid=0

Remember that simview works with tracks files that are not uploaded by server manager,
e.g. if you want to use simview with a race on Imola you need to upload on assetto\content\tracks\imola all .kn5 files from your local track folder, or if you have pregenerated simview files by another server, copy them in the simview folder (simview's generated files are under live-track-maps and tracks folders)
