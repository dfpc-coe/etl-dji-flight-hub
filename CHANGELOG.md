# CHANGELOG

## Emoji Cheatsheet
- :pencil2: doc updates
- :bug: when fixing a bug
- :rocket: when making general improvements
- :white_check_mark: when adding tests
- :arrow_up: when upgrading dependencies
- :tada: when adding new features

## Version History

### Pending Release

### v1.6.1

- :bug: Read the gimbal & Laser Range Finder from the payload index keyed OSD object (`88-0-0`), the `cameras` array only carries camera settings

### v1.6.0

- :rocket: Version Sync

### v1.5.0

- :tada: Stream live telemetry from the FlightHub 2 web socket for the remainder of each invocation
- :tada: Submit the Laser Range Finder target as a Sensor Point of Interest and use its distance as the sensor range
- :rocket: Read gimbal angles from the Cloud API `cameras` telemetry
- :rocket: Default schedule is now `rate(1 minute)` to pair with a 50 second stream
- :white_check_mark: Mock the web socket in the control tests

### v1.4.0

- :rocket: Version Sync

### v1.3.0

- :bug: Consult the Organization device list, as aircraft flown from a Remote Controller are omitted from the Project device list
- :bug: Treat aircraft returned in the gateway slot of a device pair as aircraft
- :rocket: Resolve the Project of Organization devices before requesting their Thing Model
- :pencil2: Document the Project membership required of the Organization Key user

### v1.2.0

- :arrow_up: Update Core Dependencies

### v1.1.0

- :rocket: Use CloudTAK based invocation instead of internal poll

### v1.0.0

- :tada: Aircraft, Dock & Remote Controller locations from the DJI FlightHub 2 OpenAPI (Schedule invocation)
- :tada: Default schedule of `rate(10 seconds)`
- :tada: Gimbal orientation submitted as a Sensor FoV
- :tada: Add `capabilities.json`
- :white_check_mark: Tests against a mock FlightHub 2 API
- :rocket: Initial Approach

