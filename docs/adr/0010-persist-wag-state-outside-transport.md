# ADR-0010: Persist WAG State Outside Transport

Date: 2026-09-13
Status: Proposed

WAG records that must survive reconnects or restarts are stored independently from browser and MCP connection lifetime.

The first implementation uses a storage interface with SQLite as the initial backend. Transport identifiers may be recorded for correlation, but durable WAG records remain the source used after reconnect or restart.

This decision does not add new production tools or permissions.
