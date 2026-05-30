const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 1. Mock connection packages BEFORE requiring main.js
const mockEvents = {};
const mockClient = {
  on: (event, callback) => {
    mockEvents[event] = callback;
  },
  isOpen: false,
  open: (callback) => {
    mockClient.isOpen = true;
    if (callback) callback(null);
  },
  close: (callback) => {
    mockClient.isOpen = false;
    if (callback) callback(null);
  }
};

const publishedMessages = [];
const mockMqttClient = {
  on: (event, callback) => {},
  publish: (topic, message) => {
    publishedMessages.push({ topic, message: JSON.parse(message) });
  }
};

const mockMqtt = {
  connect: () => mockMqttClient
};

require.cache[require.resolve('mqtt')] = { exports: mockMqtt };
require.cache[require.resolve('@serialport/stream')] = {
  exports: {
    SerialPortStream: function() {
      return mockClient;
    }
  }
};
require.cache[require.resolve('@serialport/bindings-cpp')] = {
  exports: {
    autoDetect: () => {}
  }
};

// Now import the main module
const app = require('../main.js');

// Constants for test SML payloads
const VALID_PAYLOAD = 
`1-0:1.8.0*255(00012345.67)
1-0:2.8.0*255(00000012.34)
1-0:1.8.1*255(00000123.45)
1-0:1.8.2*255(00000123.45)
1-0:1.8.0*96(00000001.23)
1-0:1.8.0*97(00000007.89)
1-0:1.8.0*98(00000030.12)
1-0:1.8.0*99(00000365.45)
1-0:16.7.0*255(000450)`;

const SCRAMBLED_PAYLOAD =
`1-0:1.8.0*255(00012345.67)
1-0:2.8.0*255(garbage_val)
1-0:1.8.1*255(00000123.45)
random line that does not belong
1-0:1.8.2*255(00000123.45)
1-0:1.8.0*96(00000001.23)
1-0:1.8.0*97(00000007.89)
1-0:1.8.0*98(00000030.12)
1-0:1.8.0*99(00000365.45)
1-0:16.7.0*255(000450)`;

test('Parser Module Tests', async (t) => {
  await t.test('should parse valid telemetry payloads correctly', () => {
    const dataPoint = app.parseMessage(VALID_PAYLOAD);
    assert.strictEqual(dataPoint.total, 12345.67);
    assert.strictEqual(dataPoint.total_to_grid, 12.34);
    assert.strictEqual(dataPoint.total_day, 123.45);
    assert.strictEqual(dataPoint.total_night, 123.45);
    assert.strictEqual(dataPoint.total_1d, 1.23);
    assert.strictEqual(dataPoint.total_7d, 7.89);
    assert.strictEqual(dataPoint.total_30d, 30.12);
    assert.strictEqual(dataPoint.total_365d, 365.45);
    assert.strictEqual(dataPoint.current_power, 450);
  });

  await t.test('should handle missing and scrambled/invalid formats gracefully', () => {
    const dataPoint = app.parseMessage(SCRAMBLED_PAYLOAD);
    // valid fields should parse correctly
    assert.strictEqual(dataPoint.total, 12345.67);
    assert.strictEqual(dataPoint.total_day, 123.45);
    // corrupted fields must resolve to NaN or be missing
    assert(isNaN(dataPoint.total_to_grid));
  });

  await t.test('should return an empty object for pure noise payloads', () => {
    const dataPoint = app.parseMessage('random binary noise\nand scrambled serial characters\nthat mean nothing');
    assert.deepStrictEqual(dataPoint, {});
  });

  await t.test('should return fewer than 8 keys for incomplete/partial payloads', () => {
    // Only includes 3 fields
    const partialPayload = 
`1-0:1.8.0*255(00012345.67)
1-0:2.8.0*255(00000012.34)
1-0:1.8.1*255(00000123.45)`;
    const dataPoint = app.parseMessage(partialPayload);
    assert.strictEqual(Object.keys(dataPoint).length, 3);
  });

  await t.test('should handle empty/broken value fields with NaN', () => {
    const emptyValuePayload = `1-0:1.8.0*255()`;
    const dataPoint = app.parseMessage(emptyValuePayload);
    assert(isNaN(dataPoint.total));
  });
});

test('Plausibility Engine Tests', async (t) => {
  t.beforeEach(() => {
    // Reset state baseline
    for (let key in app.lastValidValues) {
      delete app.lastValidValues[key];
    }
  });

  await t.test('should initialize values on first run when baseline is empty', () => {
    const data = { total: 1000, total_to_grid: 50 };
    const valid = app.validatePlausibility(data);
    assert.strictEqual(valid, true);
    assert.strictEqual(app.lastValidValues.total, 1000);
    assert.strictEqual(app.lastValidValues.total_to_grid, 50);
  });

  await t.test('should accept plausible slight increases', () => {
    app.lastValidValues.total = 1000;
    const data = { total: 1005 }; // +5 kWh (under the 10 kWh limit)
    const valid = app.validatePlausibility(data);
    assert.strictEqual(valid, true);
    assert.strictEqual(app.lastValidValues.total, 1005);
  });

  await t.test('should block decreasing cumulative values and restore previous baseline', () => {
    app.lastValidValues.total = 1000;
    const data = { total: 999 }; // decrease by 1
    const valid = app.validatePlausibility(data);
    assert.strictEqual(valid, false);
    // Data point should be reverted to the old value
    assert.strictEqual(data.total, 1000);
    // baseline should remain unchanged
    assert.strictEqual(app.lastValidValues.total, 1000);
  });

  await t.test('should block excessive jumps and restore previous baseline', () => {
    app.lastValidValues.total = 1000;
    const data = { total: 1015 }; // +15 kWh (above 10 kWh limit)
    const valid = app.validatePlausibility(data);
    assert.strictEqual(valid, false);
    assert.strictEqual(data.total, 1000);
    assert.strictEqual(app.lastValidValues.total, 1000);
  });
});

test('Persistence File Sync Tests', async (t) => {
  const testDir = './test_state_dir';
  const testFile = path.join(testDir, `last_values_${app.env.POWER_TYPE}.json`);

  // Cleanup helper
  const clean = () => {
    try {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
      if (fs.existsSync(`${testFile}.tmp`)) fs.unlinkSync(`${testFile}.tmp`);
      if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
    } catch (e) {}
  };

  let originalPersistPath;

  t.before(() => {
    clean();
    // Temporarily patch persist path
    originalPersistPath = app.env.PERSIST_PATH;
    app.env.PERSIST_PATH = testDir;
    for (let key in app.lastValidValues) delete app.lastValidValues[key];
  });

  t.after(() => {
    clean();
    app.env.PERSIST_PATH = originalPersistPath;
  });

  await t.test('should create folder and persist file atomically', async () => {
    app.lastValidValues.total = 5555;
    await app.saveState();
    
    assert(fs.existsSync(testFile));
    const data = JSON.parse(fs.readFileSync(testFile, 'utf8'));
    assert.strictEqual(data.total, 5555);
  });

  await t.test('should load persisted files successfully', () => {
    for (let key in app.lastValidValues) delete app.lastValidValues[key];
    app.loadState();
    assert.strictEqual(app.lastValidValues.total, 5555);
  });

  await t.test('should handle corrupt file gracefully', () => {
    fs.writeFileSync(testFile, 'corrupted json data', 'utf8');
    for (let key in app.lastValidValues) delete app.lastValidValues[key];
    
    // Should log and not throw
    assert.doesNotThrow(() => app.loadState());
    assert.deepStrictEqual(app.lastValidValues, {});
  });
});

test('Integration: Packet Stream Buffering', async (t) => {
  await t.test('should process fragmented messages separated by ! delimiter', () => {
    publishedMessages.length = 0; // Reset published array
    
    // Simulate stream receiving data in chunks
    const chunk1 = '1-0:1.8.0*255(00012345.67)\n1-0:2.8.0*255(00000012.34)\n';
    const chunk2 = '1-0:1.8.1*255(00000123.45)\n1-0:1.8.2*255(00000123.45)\n1-0:1.8.0*96(00000001.23)\n';
    const chunk3 = '1-0:1.8.0*97(00000007.89)\n1-0:1.8.0*98(00000030.12)\n1-0:1.8.0*99(00000365.45)\n1-0:16.7.0*255(000450)\n!';
    
    // Feed chunk 1
    mockEvents['data'](Buffer.from(chunk1));
    assert.strictEqual(publishedMessages.length, 0); // Incomplete
    
    // Feed chunk 2
    mockEvents['data'](Buffer.from(chunk2));
    assert.strictEqual(publishedMessages.length, 0); // Still incomplete
    
    // Adjust timing constraints temporarily to allow instant updates
    const oldInterval = app.env.DATA_INTERVAL;
    app.env.DATA_INTERVAL = -1; 
    
    // Feed chunk 3 (complete frame)
    mockEvents['data'](Buffer.from(chunk3));
    
    // Restore timing
    app.env.DATA_INTERVAL = oldInterval;
    
    // Filter messages sent to the actual data state topic
    const stateMessages = publishedMessages.filter(m => m.topic === app.env.MQTT_TOPIC);

    // Verify exactly 1 telemetry message got parsed, verified, and published
    assert.strictEqual(stateMessages.length, 1);
    const msg = stateMessages[0].message;
    assert.strictEqual(msg.total, 12345.67);
    assert.strictEqual(msg.current_power, 450);
  });
});
