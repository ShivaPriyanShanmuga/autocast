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

    /**
     * Cap how many test FILES run at once.
     *
     * Vitest defaults to roughly one worker per core, which for this
     * suite means a dozen headless Chromiums, PTYs and ffmpeg encodes
     * competing for the same RAM. That is not merely slow, it is
     * self-amplifying: a render test that runs out of memory hits its
     * timeout, vitest abandons the test but the RENDER KEEPS GOING and
     * keeps holding its browser, so the next test has less memory again.
     * One observed run leaked 33 Chromium processes, dropped the machine
     * to 3.2GB free, and took 2.9 hours instead of 22 minutes — with one
     * test reporting 9,409,456ms because it never actually stopped.
     *
     * Four is enough to keep the cores busy and few enough that the
     * spiral cannot start.
     */
    maxWorkers: 4,
    minWorkers: 1,
  },
});
