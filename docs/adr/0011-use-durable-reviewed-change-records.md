# ADR-0011: Use Durable Reviewed Change Records

Date: 2026-09-13
Status: Accepted — implemented and verified by the Durable Mutation Control Plane acceptance

The browser spike showed that a two-step host workflow is too timing-sensitive.

WAG will persist one immutable bounded change record before local review. After successful local review, WAG continues that same stored record locally and the host later reads its result.

The stored record is bound to workspace, relative path, base hash, result hash and fingerprint. WAG rechecks current local state before completion and verifies the final result afterward.

Timing remains short-lived and restart recovery does not extend stored deadlines.

This decision does not change the default or Business production surfaces.
