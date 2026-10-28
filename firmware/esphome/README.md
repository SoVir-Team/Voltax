# ESP32 firmware (ESPHome)

| File | What |
|---|---|
| `relay-1ch.yaml` | 1-channel relay + wall push button + BOOT button, MQTT to the hub |
| `secrets.yaml.example` | Template for the git-ignored `secrets.yaml` |

**Status:** not yet flashed or tested on hardware.

## Flash a device [MANUAL]

1. On the hub: `sudo add-device esp-relay-01` and copy the printed password.
2. On the installer PC: `cp secrets.yaml.example secrets.yaml` and fill it in.
3. Set `device_id` and `hub_id` at the top of `relay-1ch.yaml`.
4. First flash over USB, later flashes over the air:

```bash
pip install esphome
esphome run relay-1ch.yaml
```

The device appears in the app once it reports its state.

## Rules

- `device_id` must equal the MQTT username, because the broker ACL only lets a device use its own topics.
- No Home Assistant API and no MQTT discovery: the hub is the only consumer.
- **Safety:** use low-voltage test loads only until an electrician signs off any mains wiring.
