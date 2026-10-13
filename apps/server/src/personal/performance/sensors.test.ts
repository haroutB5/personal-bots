import { describe, expect, it } from "@effect/vitest";

import { parseFanJson, parseLhmSensors, SensorReaders } from "./sensors.ts";

/** A scaled-down LHM tree with the paths the tab reads. */
const lhmTree = () => ({
  Text: "Sensor",
  Value: "",
  Children: [
    {
      Text: "DESKTOP-X",
      Children: [
        {
          Text: "12th Gen Intel Core i7-12700H",
          Children: [
            {
              Text: "Temperatures",
              Children: [
                { Text: "P-Core #1", Value: "37.0 °C" },
                { Text: "P-Core #2", Value: "39.0 °C" },
                { Text: "P-Core #3", Value: "40.0 °C" },
                { Text: "P-Core #4", Value: "36.0 °C" },
                { Text: "P-Core #5", Value: "38.0 °C" },
                { Text: "P-Core #6", Value: "38.0 °C" },
                { Text: "E-Core #1", Value: "36.0 °C" },
                { Text: "E-Core #2", Value: "36.0 °C" },
                { Text: "E-Core #3", Value: "36.0 °C" },
                { Text: "E-Core #4", Value: "36.0 °C" },
                { Text: "E-Core #5", Value: "37.0 °C" },
                { Text: "E-Core #6", Value: "37.0 °C" },
                { Text: "E-Core #7", Value: "37.0 °C" },
                { Text: "E-Core #8", Value: "38.0 °C" },
                { Text: "CPU Package", Value: "42.0 °C" },
                { Text: "Core Max", Value: "40.0 °C" },
              ],
            },
            {
              Text: "Powers",
              Children: [
                { Text: "CPU Package", Value: "5.5 W" },
                { Text: "CPU Cores", Value: "2.3 W" },
                { Text: "CPU Platform", Value: "10.4 W" },
              ],
            },
          ],
        },
        {
          Text: "SM2P41C3 NVMe ADATA 512GB",
          Children: [
            {
              Text: "Temperatures",
              Children: [
                { Text: "Composite Temperature", Value: "40.0 °C" },
                { Text: "Warning Temperature", Value: "82.0 °C" },
                { Text: "Critical Temperature", Value: "89.0 °C" },
              ],
            },
          ],
        },
        {
          Text: "Intel(R) Iris(R) Xe Graphics",
          Children: [{ Text: "Powers", Children: [{ Text: "GPU Power", Value: "0.1 W" }] }],
        },
        {
          Text: "Micron Technology - MTC4C10163S1SC48BA1 (#0)",
          Children: [{ Text: "Temperatures", Children: [{ Text: "DIMM #0", Value: "43.5 °C" }] }],
        },
        {
          Text: "DELL M59JH28",
          Children: [
            { Text: "Powers", Children: [{ Text: "Charge/Discharge Rate", Value: "-12.5 W" }] },
            {
              Text: "Capacities",
              Children: [
                { Text: "Designed Capacity", Value: "68110 mWh" },
                { Text: "Fully-Charged Capacity", Value: "58653 mWh" },
              ],
            },
          ],
        },
      ],
    },
  ],
});

describe("parseLhmSensors", () => {
  it("reads CPU, cores, SSD with its limits, RAM, powers and battery", () => {
    const reading = parseLhmSensors(lhmTree());
    expect(reading.cpuTempC).toBe(42);
    expect(reading.pCoreC).toEqual([37, 39, 40, 36, 38, 38]);
    expect(reading.eCoreC).toEqual([36, 36, 36, 36, 37, 37, 37, 38]);
    expect(reading.ssdC).toBe(40);
    expect(reading.ssdWarnC).toBe(82);
    expect(reading.ssdCritC).toBe(89);
    expect(reading.ramC).toBe(43.5);
    expect(reading.powerCpuW).toBe(5.5);
    expect(reading.powerGpuW).toBe(0.1);
    expect(reading.powerPlatformW).toBe(10.4);
    expect(reading.batteryRateW).toBe(-12.5);
    expect(reading.batteryDesignWh).toBe(68.1);
    expect(reading.batteryFullWh).toBe(58.7);
  });

  it("is null everywhere for a tree that is not one", () => {
    const reading = parseLhmSensors({ Text: "nothing" });
    expect(reading.cpuTempC).toBeNull();
    expect(reading.pCoreC).toBeNull();
    expect(reading.ssdC).toBeNull();
  });
});

describe("parseFanJson", () => {
  it("reads both fans when ok", () => {
    expect(parseFanJson({ fan1Rpm: 2801.4, fan2Rpm: 2667, status: "ok" })).toEqual({
      status: "ok",
      fan1Rpm: 2801,
      fan2Rpm: 2667,
    });
  });

  it("keeps what is known for partial, and says unavailable otherwise", () => {
    expect(parseFanJson({ fan1Rpm: 2801, fan2Rpm: null, status: "partial" })).toEqual({
      status: "partial",
      fan1Rpm: 2801,
      fan2Rpm: null,
    });
    expect(parseFanJson({ status: "unavailable" }).status).toBe("unavailable");
    expect(parseFanJson("nope").status).toBe("down");
    expect(parseFanJson(null).status).toBe("down");
  });
});

describe("SensorReaders", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("never overlaps a fetch and clears values when one fails", async () => {
    let lhmCalls = 0;
    let lhmResult: unknown | null = lhmTree();
    let inflight = 0;
    let maxInflight = 0;
    const readers = new SensorReaders({
      fetchJson: async (url) => {
        if (url.includes("8086")) return { fan1Rpm: 100, fan2Rpm: 200, status: "ok" };
        lhmCalls += 1;
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inflight -= 1;
        return lhmResult;
      },
    });

    readers.read();
    readers.read();
    readers.read();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lhmCalls).toBe(1);
    expect(maxInflight).toBe(1);
    const ok = readers.read();
    expect(ok.lhm).toBe("ok");
    expect(ok.sensors.cpuTempC).toBe(42);
    expect(ok.fan.fan1Rpm).toBe(100);

    // Now LHM stops answering: the next completed fetch clears the values.
    lhmResult = null;
    readers.read();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const down = readers.read();
    expect(down.lhm).toBe("down");
    expect(down.sensors.cpuTempC).toBeNull();
    // The fan reader answered, so it keeps its numbers.
    expect(down.fans).toBe("ok");
    expect(down.fan.fan1Rpm).toBe(100);
    expect(readers.idle()).toBe(false);
    await tick();
  });
});
