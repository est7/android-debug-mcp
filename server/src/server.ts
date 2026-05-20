#!/usr/bin/env bun
import { bootstrap } from "./bootstrap.ts";

// Entry point. All wiring — tool registration, orphan recovery, transport
// connect — lives in bootstrap() so the boot path is unit-testable.
await bootstrap();
