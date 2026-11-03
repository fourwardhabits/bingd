# Native capture flows: UNVERIFIED

**These flows have never been run.** Maestro, adb, an Android emulator and Xcode are not
installed on the machine they were written on, and installing them was out of scope. Expect
to adjust labels and waits the first time they run. See `../NATIVE-CAPTURE.md` for why they
exist.

They assume:

- A store-signed or release-configured build, installed, on a device or simulator.
- That build already signed in to the demo account `NATIVE-CAPTURE.md` specifies. The app signs
  in by emailed code, Apple or Google, so a flow cannot log in by itself, and no credential
  belongs in this repo. Sign in by hand once, then run these.
- `appId: app.bingd`. A Preview build uses a different bundle id, so change it there if a
  flow has to run against one.

Run one, from this folder:

```
maestro test capture-core.yaml
```

Screenshots land where Maestro was started, named after each `takeScreenshot` line, which are
the scene ids in `../manifest/scenes.mjs`. Copy them into a folder and hand it to compose:

```
node compose/run.mjs --raw <folder> --status-bar <pixels>
```

Copy the raw files out of the repo tree or into `out/`: they contain poster artwork.
