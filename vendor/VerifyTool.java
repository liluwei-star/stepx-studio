import com.android.apksig.ApkVerifier;
import com.android.apksig.ApkVerifier.Result;
import java.io.File;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.List;

/**
 * APK signature verifier for STEPX Neo self-hosted projects.
 *
 * Usage:
 *   java -cp ".;apksig-android-4.4.0.jar" VerifyTool <file.apk> [more.apk ...]
 *
 * Exit code 0 = every file verified; 1 = at least one file failed.
 */
public class VerifyTool {
  public static void main(String[] args) throws Exception {
    if (args.length == 0) {
      System.err.println("Usage: VerifyTool <file.apk> [...]");
      System.exit(2);
    }
    int failures = 0;
    for (String f : args) {
      Result r = new ApkVerifier.Builder(new File(f)).build().verify();
      System.out.println("FILE=" + f);
      System.out.println("  verified=" + r.isVerified()
          + " v1=" + r.isVerifiedUsingV1Scheme()
          + " v2=" + r.isVerifiedUsingV2Scheme()
          + " v3=" + r.isVerifiedUsingV3Scheme());
      List<X509Certificate> cs = r.getSignerCertificates();
      if (cs != null) {
        for (int i = 0; i < cs.size(); i++) {
          X509Certificate c = cs.get(i);
          System.out.println("  signer[" + i + "] DN=" + c.getSubjectX500Principal().getName());
          System.out.println("  signer[" + i + "] CERT_SHA256=" + sha256hex(c.getEncoded()));
          System.out.println("  signer[" + i + "] valid=" + c.getNotBefore() + " -> " + c.getNotAfter());
        }
      }
      if (!r.isVerified()) {
        failures++;
        for (Object e : r.getErrors()) System.out.println("  ERROR=" + e);
        for (Object w : r.getWarnings()) System.out.println("  WARNING=" + w);
      }
    }
    System.exit(failures == 0 ? 0 : 1);
  }

  static String sha256hex(byte[] b) {
    try {
      MessageDigest d = MessageDigest.getInstance("SHA-256");
      StringBuilder s = new StringBuilder();
      for (byte x : d.digest(b)) s.append(String.format("%02X", x));
      return s.toString();
    } catch (Exception e) {
      return "ERR";
    }
  }
}
