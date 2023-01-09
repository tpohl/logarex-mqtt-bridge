# Home Assistant MQTT Bridge for Logarex Smart Power Meter

Just build it and run it to send MQTT Sensor Data to your Home Assistant.
I assume you have connected the IR Adapter to USB `/dev/ttyUSB0` and enabled the extended information `inf: on` on the smart meter.

Example `docker-compose.yml`

```yaml
version: "3.9"
services:
  main-power:
    build: .
    environment:
      MQTT_HOST: 192.168.1.2
      POWERTYPE: main
      MODE: 'serial'
      SERIAL_PATH: '/dev/ttyUSB0'
    devices:
      - "/dev/ttyUSB0:/dev/ttyUSB0"
```
