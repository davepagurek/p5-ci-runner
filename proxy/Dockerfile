FROM ubuntu:22.04

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends squid \
    && rm -rf /var/lib/apt/lists/*

COPY squid.conf /etc/squid/squid.conf
COPY allowed_domains.txt /etc/squid/allowed_domains.txt

EXPOSE 3128
# -N: stay in the foreground so Docker can supervise it
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
