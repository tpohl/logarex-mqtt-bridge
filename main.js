const fs = require('fs');
const path = require('path');

const env = {
  AREA: process.env.AREA || 'house',
  MQTT_HOST: process.env.MQTT_HOST || '192.168.178.100',
  MQTT_TOPIC: `house/power/${process.env.POWERTYPE || 'main'}`,
  POWER_TYPE: process.env.POWERTYPE || 'main',
  MODE: process.env.MODE || 'serial',
  SOCKET_HOST: process.env.SOCKET_HOST || '192.168.178.100',
  SOCKET_PORT: parseInt(process.env.SOCKET_PORT || '2002'),
  SERIAL_PATH: process.env.SERIAL_PATH || '/dev/ttyUSB0',
  DEBUG: process.env.DEBUG === 'true',
  DATA_INTERVAL: parseInt(process.env.DATA_INTERVAL || '30000'), // Default 30 Sec
  REGISTER_INTERVAL: parseInt(process.env.DATA_INTERVAL || '300000'), // Default 5 mins (300 Sec)
  PERSIST_PATH: process.env.PERSIST_PATH || './data'
};

function getStateFilePath() {
  return path.join(env.PERSIST_PATH, `last_values_${env.POWER_TYPE}.json`);
}

let client;

let reconnectTimeout;
function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  console.log('Scheduling reconnection in 5 seconds...');
  reconnectTimeout = setTimeout(() => {
    connect();
  }, 5000);
}

let clientConnect = function () {
  console.warn('Client Connect not configured');
};

if (env.MODE === 'socket') {
  const net = require('net');
  const socket = new net.Socket();
  client = socket;
  clientConnect = function () {
    console.log(`Connecting to socket at ${env.SOCKET_HOST}:${env.SOCKET_PORT}...`);
    socket.connect(env.SOCKET_PORT, env.SOCKET_HOST);
  };
  socket.on('error', err => {
    console.error('Socket error:', err.message);
  });
} else if (env.MODE === 'serial') {
  const { SerialPortStream } = require('@serialport/stream');
  const { autoDetect } = require('@serialport/bindings-cpp');
  const binding = autoDetect();
  const serialPort = new SerialPortStream({ binding, path: env.SERIAL_PATH, baudRate: 9600, autoOpen: false });
  client = serialPort;
  clientConnect = function () {
    if (!serialPort.isOpen) {
      console.log(`Opening serial port ${env.SERIAL_PATH}...`);
      serialPort.open(err => {
        if (err) {
          console.error('Error opening serial port:', err.message);
          scheduleReconnect();
        }
      });
    }
  };
  serialPort.on('error', err => {
    console.error('SerialPort error:', err.message);
  });
} else {
  console.warn(' Please define a valid MODE (either "serial" or "socket")');
}


const mqtt = require('mqtt');
const mqttclient = mqtt.connect(`mqtt://${env.MQTT_HOST}`);

mqttclient.on('connect', () => {
  console.log('MQTT Client connected successfully');
});
mqttclient.on('reconnect', () => {
  console.log('MQTT Client reconnecting...');
});
mqttclient.on('close', () => {
  console.log('MQTT Client connection closed');
});
mqttclient.on('offline', () => {
  console.log('MQTT Client offline');
});
mqttclient.on('error', err => {
  console.error('MQTT Client error:', err.message);
});

let received = '';
let lastUpdate = Date.parse('01 Jan 1970 00:00:00 GMT');
let lastRegister = Date.parse('01 Jan 1970 00:00:00 GMT');
let updateCounter = 0;
let registerCounter = 0;

// Saves last valid values to detect jumps
const lastValidValues = {};

function loadState() {
  const filePath = getStateFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const dataStr = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(dataStr);
      if (parsed && typeof parsed === 'object') {
        Object.assign(lastValidValues, parsed);
        console.log(`Loaded last valid values from ${filePath}:`, lastValidValues);
      }
    } else {
      console.log(`No previous state file found at ${filePath}. Starting fresh.`);
    }
  } catch (err) {
    console.warn(`Could not load previous state from ${filePath}:`, err.message);
  }
}

async function saveState() {
  const filePath = getStateFilePath();
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp`;
    const dataStr = JSON.stringify(lastValidValues, null, 2);
    
    await fs.promises.writeFile(tempPath, dataStr, 'utf8');
    await fs.promises.rename(tempPath, filePath);
    
    if (env.DEBUG) {
      console.log('Successfully persisted last valid values:', lastValidValues);
    }
  } catch (err) {
    console.error('Failed to persist last valid values:', err.message);
  }
}

function parseMessage(message) {
  let dataPoint = {};
  const lines = message.split('\n');
  for (let line of lines) {
    if (line.startsWith('1-0:1.8.0*255(')) {
      dataPoint['total'] = parseFloat(line.substring(14, 25));
    } else if (line.startsWith('1-0:2.8.0*255(')) {
      dataPoint['total_to_grid'] = parseFloat(line.substring(14, 25));
    } else if (line.startsWith('1-0:1.8.1*255(')) {
      dataPoint['total_day'] = parseFloat(line.substring(14, 25));
    } else if (line.startsWith('1-0:1.8.2*255(')) {
      dataPoint['total_night'] = parseFloat(line.substring(14, 25));
    } else if (line.startsWith('1-0:1.8.0*96(')) {
      dataPoint['total_1d'] = parseFloat(line.substring(13, 24));
    } else if (line.startsWith('1-0:1.8.0*97(')) {
      dataPoint['total_7d'] = parseFloat(line.substring(13, 24));
    } else if (line.startsWith('1-0:1.8.0*98(')) {
      dataPoint['total_30d'] = parseFloat(line.substring(13, 24));
    } else if (line.startsWith('1-0:1.8.0*99(')) {
      dataPoint['total_365d'] = parseFloat(line.substring(13, 24));
    } else if (line.startsWith('1-0:16.7.0*255(')) {
      dataPoint['current_power'] = parseFloat(line.substring(15, 21));
    }
  }
  return dataPoint;
}

function validatePlausibility(dataPoint) {
  const measuresToCheck = ['total', 'total_to_grid', 'total_day', 'total_night'];
  let isDataPlausible = true;

  for (const measure of measuresToCheck) {
    if (dataPoint[measure] !== undefined && !isNaN(dataPoint[measure])) {
      const newValue = dataPoint[measure];
      const oldValue = lastValidValues[measure];

      if (oldValue !== undefined) {
        const diff = newValue - oldValue;

        // If value is decreasing or jumping by more than 10 kWh -> Unplausible!
        if (diff < 0 || diff > 10) {
          console.warn(`⚠️ BLOCKED: Jump at ${measure}! old: ${oldValue}, new: ${newValue} (Diff: ${diff} kWh)`);
          isDataPlausible = false;
          dataPoint[measure] = oldValue;
        }
      }

      if (isDataPlausible || oldValue === undefined) {
        lastValidValues[measure] = dataPoint[measure];
      }
    }
  }
  return isDataPlausible;
}

client.on('data', data => {
  received += data.toString();
  const messages = received.split('!');
  if (messages.length > 1) {
    received = messages.pop();
    for (let message of messages) {
      if (message !== '') {
        const dataPoint = parseMessage(message);
        if (Object.keys(dataPoint).length >= 8) {
          if (Date.now() > (lastUpdate + env.DATA_INTERVAL)) {
            validatePlausibility(dataPoint);

            if (env.DEBUG || updateCounter < 11) {
              console.log('Sending Data Point', dataPoint);
            }
            //Reregister
            registerConfig();

            // Send
            lastUpdate = Date.now();
            mqttclient.publish(env.MQTT_TOPIC, JSON.stringify(dataPoint));

            // Save state to disk asynchronously
            saveState();

            // Update Counter
            updateCounter++;
            if (updateCounter < 11 || updateCounter % 100 === 0) {
              console.log(`Sent ${updateCounter} messages`);
            }
          }
        }
      }
    }
  }
});
client.on('close', () => {
  console.log('Connection closed.');
  scheduleReconnect();
});


function connect() {
  // Send Autoconfig to Home Assistant
  registerConfig();
  clientConnect();
  console.log(
    `
   __        ______     _______      ___      .______       __________   ___    .___  ___.   ______     .___________.___________.
  |  |      /  __  \\   /  _____|    /   \\     |   _  \\     |   ____\\  \\ /  /    |   \\/   |  /  __  \\    |           |           |
  |  |     |  |  |  | |  |  __     /  ^  \\    |  |_)  |    |  |__   \\  V  /     |  \\  /  | |  |  |  |   \`---|  |----\`---|  |----\`
  |  |     |  |  |  | |  | |_ |   /  /_\\  \\   |      /     |   __|   >   <      |  |\\/|  | |  |  |  |       |  |        |  |     
  |  \`----.|  \`--'  | |  |__| |  /  _____  \\  |  |\\  \\----.|  |____ /  .  \\     |  |  |  | |  \`--'  '--.    |  |        |  |     
  |_______| \\______/   \\______| /__/     \\__\\ | _| \`._____||_______/__/ \\__\\    |__|  |__|  \\_____\\_____\\   |__|        |__|     
                                                                                                                                 
  Logarex Power Meter to MQTT Bridge
  `
  );
  console.log('Connected for Parameters', env);
}

function registerConfig() {
  if (Date.now() > (lastRegister + env.REGISTER_INTERVAL)) {
    lastRegister = Date.now();
    registerSubConfig('total');
    registerSubConfig('total_to_grid');
    registerSubConfig('total_day');
    registerSubConfig('total_night');
    registerSubConfig('total_1d', 'total');
    registerSubConfig('total_7d', 'total');
    registerSubConfig('total_30d', 'total');
    registerSubConfig('total_365d', 'total');
    registerSubConfig('current_power', 'measurement', 'W', 'power');

    // Update Register Counter
    registerCounter++;
    if (registerCounter < 11 || registerCounter % 100 === 0) {
      console.log(`Registered ${registerCounter} times`);
    }
  }
}

function registerSubConfig(measure, state_class = 'total_increasing', unit = 'kWh', device_class = 'energy') {
  const config = {
    'object_id': `energy_${env.POWER_TYPE}_${measure}`,
    'entity_id': `energy_${env.POWER_TYPE}_${measure}`,
    'unique_id': `energy_${env.POWER_TYPE}_${measure}`,
    name: `Energy ${env.POWER_TYPE} ${measure}`,
    'state_topic': env.MQTT_TOPIC,
    'state_class': state_class,
    'device_class': device_class,
    device: {
      identifiers: `logarex-meter-${env.POWER_TYPE}`,
      name: `Electricity Meter ${env.POWER_TYPE}`,
      model: `Logarex`,
      suggested_area: `${env.AREA}`,
      'via_device': `logarex-mqtt-bridge-${env.POWER_TYPE}`
    },
    'unit_of_measurement': unit,
    'value_template': `{{ value_json.${measure} }}`
  };
  mqttclient.publish(`homeassistant/sensor/${config.object_id}/config`, JSON.stringify(config));
  if (env.DEBUG) {
    console.log('Registering Config', config);
  }
  return config;
}

if (require.main === module) {
  loadState();
  connect();
}

// Graceful shutdown
const shutdown = () => {
  console.log('Shutdown signal received. Closing connections...');
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (client) {
    if (env.MODE === 'socket') {
      client.destroy();
    } else if (env.MODE === 'serial') {
      client.close();
    }
  }
  if (mqttclient) {
    mqttclient.end();
  }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = {
  env,
  lastValidValues,
  parseMessage,
  validatePlausibility,
  loadState,
  saveState,
  getStateFilePath
};
