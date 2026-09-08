import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'fixtures/**/*.test.ts'],

    /**
     * Vitest's defaults are sized for unit tests. Almost nothing here is
     * one: these tests launch Chromium, open real PTYs, and run ffmpeg,
     * and several do all three at once while the suite runs files in
     * parallel.
     *
     * The 10s hook default was the specific problem. Browser setup and
     * teardown hooks exceeded it under load and failed four tests that
     * pass every time in isolation — a flake that says nothing about the
     * code and costs a full re-run to dismiss.
     *
     * Individual tests still set their own timeouts where they know
     * better; this only raises the floor.
     */
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
