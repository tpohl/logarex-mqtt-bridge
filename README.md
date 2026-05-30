# Home Assistant MQTT Bridge for Logarex Smart Power Meter

Just build it and run it to send MQTT Sensor Data to your Home Assistant.
I assume you have connected the IR Adapter to USB `/dev/ttyUSB0` and enabled the extended information `inf: on` on the smart meter.

Example `docker-compose.yml`

```yaml
services:
  main-power:
    build: .
    environment:
      AREA: House
      MQTT_HOST: 192.168.1.2
      POWERTYPE: main
      MODE: 'serial'
      SERIAL_PATH: '/dev/ttyUSB0'
      PERSIST_PATH: '/app/data'
    restart: unless-stopped
    devices:
      - "/dev/ttyUSB0:/dev/ttyUSB0"
    volumes:
      - logarex-data:/app/data

volumes:
  logarex-data:
```

