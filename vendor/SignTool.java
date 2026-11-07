import com.android.apksig.ApkSigner;
import java.io.File;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Collections;

/**
 * Desktop APK signer for STEPX Neo self-hosted projects.
 * Uses apksig-android (the on-device port) — the same library the StepX Studio
 * uses at runtime, so signatures produced here are byte-compatible with its V2/V3 output.
 *
 * Usage:
 *   java -cp ".;apksig-android-4.4.0.jar" SignTool <ks> <pass> <alias> <in.apk> <out.apk>
 */
public class SignTool {
  public static void main(String[] args) throws Exception {
    if (args.length != 5) {
      System.err.println("Usage: SignTool <keystore> <pass> <alias> <in.apk> <out.apk>");
      System.exit(2);
    }
    String ks = args[0], pass = args[1], alias = args[2], in = args[3], out = args[4];

    KeyStore k = KeyStore.getInstance("PKCS12");
    try (java.io.FileInputStream f = new java.io.FileInputStream(ks)) {
      k.load(f, pass.toCharArray());
    }
    if (!k.containsAlias(alias)) {
      throw new IllegalArgumentException("alias not found in keystore: " + alias);
    }
    PrivateKey pk = (PrivateKey) k.getKey(alias, pass.toCharArray());
    X509Certificate c = (X509Certificate) k.getCertificate(alias);
    if (pk == null || c == null) {
      throw new IllegalArgumentException("keystore entry has no usable key/certificate");
    }

    ApkSigner.SignerConfig sc = new ApkSigner.SignerConfig.Builder(alias, pk, Collections.singletonList(c)).build();
    new ApkSigner.Builder(Collections.singletonList(sc))
        .setInputApk(new File(in))
        .setOutputApk(new File(out))
        .setMinSdkVersion(30)
        .setV1SigningEnabled(false)
        .setV2SigningEnabled(true)
        .setV3SigningEnabled(true)
        .setV4SigningEnabled(false)
        .build()
        .sign();

    System.out.println("SIGNED_OK " + out + " " + new File(out).length() + " bytes");
  }
}
