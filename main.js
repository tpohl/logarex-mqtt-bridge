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
};

let client;

let clientConnect = function () {
  console.warn('Client Connect not configured');
};

if (env.MODE === 'socket') {
  const net = require('net');
  const socket = new net.Socket();
  client = socket;
  clientConnect = function () {
    socket.connect(env.SOCKET_PORT, env.SOCKET_HOST);
  };
} else if (env.MODE === 'serial') {
  const { SerialPortStream } = require('@serialport/stream');
  const { autoDetect } = require('@serialport/bindings-cpp');
  const binding = autoDetect();
  const serialPort = new SerialPortStream({ binding, path: env.SERIAL_PATH, baudRate: 9600, autoOpen: true });
  client = serialPort;
  clientConnect = function () {
    // Do nothing, auto opening.
  };
} else {
  console.warn(' Please define a valid MODE (either "serial" or "socket"');
}


const mqtt = require('mqtt');
const mqttclient = mqtt.connect(`mqtt://${env.MQTT_HOST}`);

let received = '';
let lastUpdate = Date.parse('01 Jan 1970 00:00:00 GMT');
let lastRegister = Date.parse('01 Jan 1970 00:00:00 GMT');
let updateCounter = 0;
let registerCounter = 0;

client.on('data', data => {
  received += data;
  const messages = received.split('!');
  if (messages.length > 1) {
    for (let message of messages) {
      if (message !== '') {

        let dataPoint = {};
        const lines = message.split('\n');
        for (let line of lines) {
          if (line.startsWith('1-0:1.8.0*255(')) {
            dataPoint['total'] = parseFloat(line.substring(14, 25));
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
        if (Object.keys(dataPoint).length >= 8) {
          if (Date.now() > (lastUpdate + env.DATA_INTERVAL)) {
            if (env.DEBUG) {
              console.log('Sending Data Point', dataPoint);
            }
            //Reregister
            registerConfig();
            
            // Send
            lastUpdate = Date.now();
            mqttclient.publish(env.MQTT_TOPIC, JSON.stringify(dataPoint));

            // Update Counter
            updateCounter ++;
            if (updateCounter % 100 === 0){
              console.log(`Sent ${updateCounter} messages`);
            }
          }
        }
        
        received = '';
      }
    }
  }
});
client.on('close', () => {
  connect();
  console.log('connection closed');
});


function connect() {
  // Send Autoconfig to Home Assistant
  registerConfig();
  clientConnect();
}

function registerConfig() {
  if (Date.now() > (lastRegister + env.DATA_INTERVAL)) {
    lastRegister = Date.now();
    registerSubConfig('total');
    registerSubConfig('total_day');
    registerSubConfig('total_night');
    registerSubConfig('total_1d', 'total');
    registerSubConfig('total_7d', 'total');
    registerSubConfig('total_30d', 'total');
    registerSubConfig('total_365d', 'total');
    registerSubConfig('current_power', 'measurement', 'W', 'power');

    // Update Register Counter
    registerCounter ++;
    if (registerCounter % 100 === 0){
      console.log(`Registered ${registerCounter} times`);
    }
  }
}

function registerSubConfig(measure, state_class = 'total_increasing', unit = 'kWh', device_class = 'energy') {
  const config = {
    object_id: `energy_${env.POWER_TYPE}_${measure}`,
    entity_id: `energy_${env.POWER_TYPE}_${measure}`,
    unique_id: `energy_${env.POWER_TYPE}_${measure}`,
    name: `Energy ${env.POWER_TYPE} ${measure}`,
    state_topic: env.MQTT_TOPIC,
    state_class: state_class,
    device_class: device_class,
    device: {
      identifiers: `logarex-meter-${env.POWER_TYPE}`,
      name: `Electricity Meter ${env.POWER_TYPE}`,
      model: `Logarex`,
      suggested_area: `${env.AREA}`,
      via_device: `logarex-mqtt-bridge-${env.POWER_TYPE}`
    },
    unit_of_measurement: unit,
    value_template: `{{ value_json.${measure} }}`
  };
  mqttclient.publish(`homeassistant/sensor/${config.object_id}/config`, JSON.stringify(config));
  if (env.DEBUG) {
    console.log('Registering Config', config);
  }
  return config;
}

connect();
