#!/bin/bash
rsync -av --exclude=node_modules ~/nas/workspace/profiles/karaqueue/ ~/karaqueue/
cd ~/karaqueue
npm install
node server.js
