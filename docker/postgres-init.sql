-- Runs only on FIRST boot of the postgres container (when the data
-- volume is empty). Creates one database per shard so the single
-- Postgres instance can act as all 4 logical clusters this service
-- talks to.
--
-- In real production each of these would be its own Postgres cluster
-- in its own region. For local dev / homework one instance is enough.

CREATE DATABASE order_service_eg;
CREATE DATABASE order_service_ksa;
CREATE DATABASE order_service_archive_eg;
CREATE DATABASE order_service_archive_ksa;
