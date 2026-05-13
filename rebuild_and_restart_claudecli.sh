#!/bin/bash
echo "sudo systemctl stop cloudcli.service"
sudo systemctl stop cloudcli.service

#npm install
echo "npm ci"
npm ci
echo "npm run build"
npm run build
echo "sudo systemctl restart cloudcli.service"
sudo systemctl restart cloudcli.service
