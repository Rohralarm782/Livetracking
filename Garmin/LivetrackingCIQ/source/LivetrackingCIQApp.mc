import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;
using Toybox.BluetoothLowEnergy as Ble;

class LivetrackingCIQApp extends Application.AppBase {

    // Haelt den BLE-Client am Leben. Muss ein Member sein - eine lokale
    // Variable wuerde vom Garbage Collector eingesammelt.
    hidden var mBleDelegate = null;

    function initialize() {
        AppBase.initialize();
    }

    // onStart() is called on application start up
    function onStart(state as Dictionary?) as Void {
        // Auf Geraeten ohne BLE-Unterstuetzung bleibt mBleDelegate null;
        // die View zeigt dann "NO BLE" statt abzustuerzen.
        if (Toybox has :BluetoothLowEnergy) {
            mBleDelegate = new LivetrackingCIQBleDelegate();
            Ble.setDelegate(mBleDelegate);
            mBleDelegate.start();
        }
    }

    // onStop() is called when your application is exiting
    function onStop(state as Dictionary?) as Void {
        if (mBleDelegate != null) {
            mBleDelegate.stop();
            mBleDelegate = null;
        }
    }

    // Wird gerufen, wenn der Nutzer die Einstellungen in Garmin Connect
    // geaendert und synchronisiert hat.
    function onSettingsChanged() as Void {
        if (mBleDelegate != null) {
            mBleDelegate.reloadSettings();
        }
    }

    // Return the initial view of your application here
    function getInitialView() as [Views] or [Views, InputDelegates] {
        return [ new LivetrackingCIQView(mBleDelegate) ];
    }

}

function getApp() as LivetrackingCIQApp {
    return Application.getApp() as LivetrackingCIQApp;
}