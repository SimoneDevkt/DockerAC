FROM ubuntu:18.04

ENV SERVER_MANAGER_DIR /home/assetto/server-manager
ENV SERVER_INSTALL_DIR ${SERVER_MANAGER_DIR}/assetto

ENV LANG C.UTF-8
RUN apt-get update && apt-get install -y build-essential libssl-dev curl lib32gcc1 lib32stdc++6 zlib1g zlib1g lib32z1 ca-certificates && rm -rf /var/lib/apt/lists/*

RUN mkdir -p ${SERVER_MANAGER_DIR} && mkdir ${SERVER_INSTALL_DIR}

ADD servermanager/server-manager ${SERVER_MANAGER_DIR}/server-manager
ADD servermanager/assetto-multiserver-manager ${SERVER_MANAGER_DIR}/assetto-multiserver-manager

RUN chmod +x ${SERVER_MANAGER_DIR}/server-manager ${SERVER_MANAGER_DIR}/assetto-multiserver-manager

WORKDIR ${SERVER_MANAGER_DIR}

ENTRYPOINT ["./server-manager"]
