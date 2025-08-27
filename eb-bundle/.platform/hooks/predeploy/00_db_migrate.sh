#!/bin/bash
set -euo pipefail
[ -f /opt/elasticbeanstalk/support/envvars ] && { set -a; . /opt/elasticbeanstalk/support/envvars; set +a; }
[ -f /opt/elasticbeanstalk/deployment/env ] && { set -a; . /opt/elasticbeanstalk/deployment/env; set +a; }

IMG_TAG="${LISTMONK_IMAGE_TAG:-v5.0.3}"
IMAGE="listmonk/listmonk:${IMG_TAG}"

: "${LISTMONK_db__host:?missing LISTMONK_db__host}"
: "${LISTMONK_db__user:?missing LISTMONK_db__user}"
: "${LISTMONK_db__password:?missing LISTMONK_db__password}"
: "${LISTMONK_db__database:=listmonk}"
: "${LISTMONK_db__port:=5432}"
: "${LISTMONK_db__ssl_mode:=require}"
: "${LISTMONK_app__address:=0.0.0.0:9000}"

docker pull "${IMAGE}"

run_in_tmp() {
  docker run --rm \
    --user 0:0 -e PUID=0 -e PGID=0 \
    -e LISTMONK_db__host -e LISTMONK_db__user -e LISTMONK_db__password \
    -e LISTMONK_db__database -e LISTMONK_db__port -e LISTMONK_db__ssl_mode \
    -e LISTMONK_app__address \
    "${IMAGE}" ./listmonk "$@"
}

TRIES=24; SLEEP=5
for i in $(seq 1 $TRIES); do
  if run_in_tmp --upgrade --yes --config= >/dev/null 2>&1; then
    echo "[predeploy] upgrade OK"; exit 0
  fi
  echo "[predeploy] upgrade not ready (attempt $i/$TRIES); sleeping ${SLEEP}s..."
  sleep $SLEEP
done

echo "[predeploy] attempting fresh install..."
run_in_tmp --install --idempotent --yes --config=
echo "[predeploy] schema installed"