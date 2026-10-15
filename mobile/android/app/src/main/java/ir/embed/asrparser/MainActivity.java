package ir.embed.asrparser;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioPickerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
