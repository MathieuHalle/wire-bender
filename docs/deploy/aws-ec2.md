# WireBender on an AWS EC2 instance

One small instance running `compose.yaml`: Caddy for HTTPS in front, WireBender and its SQLite database on the instance's disk. This guide sets it up by hand in the AWS console; the README's "Self-host with Docker" has the details of `.env` and the containers.

You need: an AWS account, a domain whose DNS you can change (Route 53 or elsewhere), and a GitHub account for the sign-in app.

## 1. Launch the instance

EC2 → Launch instances:

- **Name:** `wirebender`
- **Image:** Ubuntu Server 24.04 LTS, **64-bit (Arm)**
- **Type:** `t4g.small` (2 vCPU, 2 GB). Plenty to run WireBender; the build needs swap (step 5). `t3.small` with the x86 Ubuntu image works the same.
- **Key pair:** none, if you connect with Session Manager (below); otherwise one of yours.
- **Network:** your VPC, a public subnet, auto-assign public IP on.
- **Security group:** a new one, `wirebender`:
  - HTTP, TCP 80, from anywhere (IPv4 and IPv6): Caddy needs it for the certificate, and sends visitors on to HTTPS.
  - HTTPS, TCP 443, from anywhere.
  - Custom UDP 443, from anywhere (HTTP/3; optional).
  - SSH 22 from **My IP** only, and only if you use a key pair. Never from anywhere.
- **Storage:** 20 GiB gp3, encrypted.
- **Advanced → IAM instance profile:** a role with the `AmazonSSMManagedInstanceCore` policy (create it once: IAM → Roles → Create role → EC2 → that policy). It lets you open a shell from the console (EC2 → Connect → Session Manager) with no SSH port and no key, and a deploy pipeline will use it later.
- **Advanced → Metadata version:** V2 only (the default).
- **Tags:** add `Backup` = `wirebender` (step 4 uses it).

## 2. A fixed address

EC2 → Elastic IPs → Allocate → then Actions → Associate with the `wirebender` instance. The address stays the same across stops and restarts, so DNS can point at it.

## 3. DNS

Route 53 → Hosted zones → your domain → Create record: name `wire` (or whatever you choose), type `A`, value the Elastic IP, TTL 300. With another DNS provider, the same A record there.

Wait for it to answer before step 6 (`dig +short wire.example.org` shows the Elastic IP): Caddy asks Let's Encrypt for the certificate on its first start, and a failed check counts against Let's Encrypt's limits.

## 4. Snapshots (off-machine backups)

WireBender's daily backups are in `/data/backups`, on the same disk as the database: they do not survive losing the instance. An EBS snapshot does.

EC2 → Lifecycle Manager → Create lifecycle policy → EBS snapshot policy: target resource type Volume (or Instance), target tag `Backup` = `wirebender`, daily, keep 14. Restore by creating a volume from a snapshot (README, Backups, has the rest).

## 5. Prepare the instance

Open a shell (EC2 → Connect → Session Manager, then `sudo -iu ubuntu`, or SSH as `ubuntu`).

Docker, from Docker's own repository:

```sh
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu   # then log out and back in
```

Cap the container logs, which otherwise grow until the disk is full:

```sh
echo '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
```

Swap, for the build: building the app takes about 3.7 GB of memory at its peak, more than a 2 GB instance has.

```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Ubuntu installs its security updates on its own (unattended-upgrades); a kernel update needs a reboot now and then (`sudo reboot`; the containers come back by themselves).

## 6. WireBender

Register the sign-in app first: GitHub → Settings → Developer settings → OAuth Apps → New OAuth App, with homepage `https://wire.example.org` and callback `https://wire.example.org/auth/github` (your domain). Keep the client ID and a new client secret for `.env`. Use a new app for this server, not the one you test with locally.

```sh
sudo mkdir -p /opt/wirebender && sudo chown ubuntu: /opt/wirebender
git clone https://github.com/<owner>/wire-bender.git /opt/wirebender   # a private repo needs a deploy key or token
cd /opt/wirebender
cp .env.example .env && chmod 600 .env
nano .env
```

In `.env`: `WIREBENDER_URL=https://wire.example.org`, `WIREBENDER_DOMAIN=wire.example.org`, `NUXT_APP_SECRET` from `openssl rand -hex 32`, and the GitHub client ID and secret. Keep `COMPOSE_PROFILES=https`. The containers' network defaults to `192.168.213.0/24`; set `WIREBENDER_NET` only if your VPC or a VPN uses that range.

```sh
docker compose up -d --build
docker compose logs -f wirebender   # wait for the setup code, then Ctrl-C
docker compose logs caddy | grep -i certificate
```

Open `https://wire.example.org`, sign in with GitHub, go to `/setup` and enter the setup code: you are the first admin.

Keep a copy of `.env` somewhere safe (a password manager): the snapshots have it, but without its `NUXT_APP_SECRET` every session ends.

## Upgrade

```sh
cd /opt/wirebender && git pull && docker compose up -d --build
```

The server writes a `pre-migration-*` backup before it changes the database layout. Reload open board tabs afterwards.

## Checks

- `curl -s https://wire.example.org/api/health` answers `{"ok":true,"mode":"public"}`.
- `http://wire.example.org` sends you to `https://`.
- Port 3000 is not reachable from outside (it is published on `127.0.0.1` only): `curl -m 5 http://<elastic ip>:3000` from your computer times out.
- `docker compose ps` shows both containers `Up`, WireBender `(healthy)`.
