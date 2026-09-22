package ai.d6e.signkit.pades;

import eu.europa.esig.dss.enumerations.SignatureLevel;
import eu.europa.esig.dss.model.FileDocument;
import eu.europa.esig.dss.simplereport.SimpleReport;
import eu.europa.esig.dss.simplereport.jaxb.XmlTimestamp;
import eu.europa.esig.dss.spi.DSSUtils;
import eu.europa.esig.dss.spi.validation.CommonCertificateVerifier;
import eu.europa.esig.dss.spi.x509.CommonTrustedCertificateSource;
import eu.europa.esig.dss.validation.SignedDocumentValidator;
import eu.europa.esig.dss.validation.reports.Reports;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.Arrays;
import java.util.Collection;
import java.util.Date;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.interactive.digitalsignature.PDSignature;
import org.bouncycastle.asn1.ASN1InputStream;
import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.cms.Attribute;
import org.bouncycastle.asn1.cms.AttributeTable;
import org.bouncycastle.asn1.cms.ContentInfo;
import org.bouncycastle.asn1.ess.ESSCertIDv2;
import org.bouncycastle.asn1.ess.SigningCertificateV2;
import org.bouncycastle.asn1.nist.NISTObjectIdentifiers;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.GeneralName;
import org.bouncycastle.asn1.x509.IssuerSerial;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cms.CMSSignedData;
import org.bouncycastle.cms.SignerInformation;
import org.bouncycastle.tsp.TimeStampToken;

public final class DssValidate {
  private static final Instant VALIDATION_TIME = Instant.parse("2026-09-23T00:00:00Z");
  private static final String TIMESTAMPING_EKU = "1.3.6.1.5.5.7.3.8";
  private static final String EXTENDED_KEY_USAGE = "2.5.29.37";

  private record Validated(Reports reports, SimpleReport simple, String signatureId) {}

  private DssValidate() {}

  public static void main(String[] args) throws Exception {
    if (args.length != 1) {
      throw new IllegalArgumentException("usage: DssValidate <fixture-directory>");
    }
    Path fixtureDirectory = Path.of(args[0]).toAbsolutePath().normalize();
    Path reportsDirectory = fixtureDirectory.resolve("reports");
    Files.createDirectories(reportsDirectory);

    CommonTrustedCertificateSource trust = new CommonTrustedCertificateSource();
    try (Stream<Path> certificates = Files.list(fixtureDirectory.resolve("trust"))) {
      for (Path certificate :
          certificates.filter(path -> path.toString().endsWith(".pem")).toList()) {
        addTrustedCertificate(trust, certificate);
      }
    }

    CommonCertificateVerifier verifier = new CommonCertificateVerifier();
    verifier.setTrustedCertSources(trust);

    validatePositive(
        fixtureDirectory.resolve("pades-b-b.pdf"),
        reportsDirectory,
        "b-b",
        SignatureLevel.PAdES_BASELINE_B,
        false,
        verifier);
    validatePositive(
        fixtureDirectory.resolve("pades-b-t.pdf"),
        reportsDirectory,
        "b-t",
        SignatureLevel.PAdES_BASELINE_T,
        true,
        verifier);
    validateRejected(
        fixtureDirectory.resolve("tampered-b-b.pdf"),
        reportsDirectory,
        "tampered-b-b",
        false,
        verifier);
    validateRejected(
        fixtureDirectory.resolve("tampered-b-t.pdf"),
        reportsDirectory,
        "tampered-b-t",
        true,
        verifier);
    for (String invalidFixture :
        List.of(
            "ess-missing",
            "ess-mismatch",
            "tsa-eku-absent",
            "tsa-eku-noncritical",
            "tsa-eku-multipurpose")) {
      validateRejected(
          fixtureDirectory.resolve("invalid-" + invalidFixture + ".pdf"),
          reportsDirectory,
          invalidFixture,
          true,
          verifier);
    }

    String dssVersion = System.getProperty("signkit.dss.version");
    require(dssVersion != null && !dssVersion.isBlank(), "DSS version provenance is missing");
    Files.writeString(
        reportsDirectory.resolve("dss-version.txt"), dssVersion + "\n", StandardCharsets.UTF_8);
  }

  private static void addTrustedCertificate(CommonTrustedCertificateSource trust, Path path)
      throws IOException {
    try (InputStream input = Files.newInputStream(path)) {
      trust.addCertificate(DSSUtils.loadCertificate(input));
    }
  }

  private static Validated validate(Path pdf, CommonCertificateVerifier verifier) {
    SignedDocumentValidator validator =
        SignedDocumentValidator.fromDocument(new FileDocument(pdf.toFile()));
    validator.setCertificateVerifier(verifier);
    validator.setValidationTime(Date.from(VALIDATION_TIME));
    Reports reports = validator.validateDocument();
    SimpleReport simple = reports.getSimpleReport();
    List<String> signatures = simple.getSignatureIdList();
    require(signatures.size() == 1, pdf + " must contain exactly one signature");
    return new Validated(reports, simple, signatures.get(0));
  }

  private static void validatePositive(
      Path pdf,
      Path reportsDirectory,
      String reportName,
      SignatureLevel expectedLevel,
      boolean timestampExpected,
      CommonCertificateVerifier verifier)
      throws IOException {
    Validated validated = validate(pdf, verifier);
    writeReports(validated.reports(), reportsDirectory, reportName);
    assertTimestampPolicy(pdf, timestampExpected);
    require(validated.simple().isValid(validated.signatureId()), pdf + " signature is not valid");
    require(
        expectedLevel.equals(validated.simple().getSignatureFormat(validated.signatureId())),
        pdf + " did not validate as " + expectedLevel);
    List<XmlTimestamp> timestamps =
        validated.simple().getSignatureTimestamps(validated.signatureId());
    require(
        timestampExpected == !timestamps.isEmpty(),
        pdf + " timestamp presence does not match its requested profile");
    for (XmlTimestamp timestamp : timestamps) {
      require(
          validated.simple().isValid(timestamp.getId()),
          pdf + " contains an invalid signature timestamp");
    }
  }

  private static void validateRejected(
      Path pdf,
      Path reportsDirectory,
      String reportName,
      boolean timestampExpected,
      CommonCertificateVerifier verifier)
      throws IOException {
    Validated validated = validate(pdf, verifier);
    writeReports(validated.reports(), reportsDirectory, reportName);
    boolean policyRejected = false;
    try {
      assertTimestampPolicy(pdf, timestampExpected);
    } catch (IllegalStateException exception) {
      policyRejected = true;
    }
    require(
        policyRejected || !validated.simple().isValid(validated.signatureId()),
        pdf + " unexpectedly passed the DSS validation boundary");
  }

  private static void assertTimestampPolicy(Path pdf, boolean timestampExpected) {
    try {
      byte[] pdfBytes = Files.readAllBytes(pdf);
      try (PDDocument document = Loader.loadPDF(pdfBytes)) {
        List<PDSignature> signatures = document.getSignatureDictionaries();
        require(signatures.size() == 1, pdf + " must contain exactly one PDF signature");
        byte[] paddedContents = signatures.get(0).getContents(pdfBytes);
        ContentInfo pdfContent;
        try (ASN1InputStream asn1 = new ASN1InputStream(paddedContents)) {
          pdfContent = ContentInfo.getInstance(asn1.readObject());
        }
        CMSSignedData pdfSignature = new CMSSignedData(pdfContent);
        Collection<SignerInformation> pdfSigners = pdfSignature.getSignerInfos().getSigners();
        require(pdfSigners.size() == 1, pdf + " must contain exactly one CMS signer");
        SignerInformation pdfSigner = pdfSigners.iterator().next();
        AttributeTable unsignedAttributes = pdfSigner.getUnsignedAttributes();
        Attribute timestampAttribute =
            unsignedAttributes == null
                ? null
                : unsignedAttributes.get(PKCSObjectIdentifiers.id_aa_signatureTimeStampToken);
        require(
            timestampExpected == (timestampAttribute != null),
            pdf + " timestamp presence does not match its requested profile");
        if (timestampAttribute == null) {
          return;
        }
        require(
            timestampAttribute.getAttrValues().size() == 1,
            pdf + " must contain exactly one timestamp token");
        ContentInfo timestampContent =
            ContentInfo.getInstance(timestampAttribute.getAttrValues().getObjectAt(0));
        TimeStampToken timestamp = new TimeStampToken(timestampContent);
        Collection<X509CertificateHolder> tsaCertificates =
            timestamp.getCertificates().getMatches(timestamp.getSID());
        require(
            tsaCertificates.size() == 1, pdf + " timestamp must embed its exact TSA certificate");
        X509CertificateHolder tsaCertificate = tsaCertificates.iterator().next();
        assertTsaEku(pdf, tsaCertificate);
        assertEssCertIdV2(pdf, timestamp.getSignedAttributes(), tsaCertificate);
      }
    } catch (IllegalStateException exception) {
      throw exception;
    } catch (Exception exception) {
      throw new IllegalStateException(pdf + " timestamp policy could not be evaluated", exception);
    }
  }

  private static void assertTsaEku(Path pdf, X509CertificateHolder holder) throws Exception {
    X509Certificate certificate = new JcaX509CertificateConverter().getCertificate(holder);
    List<String> eku = certificate.getExtendedKeyUsage();
    require(
        eku != null && eku.equals(List.of(TIMESTAMPING_EKU)),
        pdf + " TSA EKU must contain only timeStamping");
    Set<String> criticalExtensions = certificate.getCriticalExtensionOIDs();
    require(
        criticalExtensions != null && criticalExtensions.contains(EXTENDED_KEY_USAGE),
        pdf + " TSA EKU must be critical");
  }

  private static void assertEssCertIdV2(
      Path pdf, AttributeTable signedAttributes, X509CertificateHolder tsaCertificate)
      throws Exception {
    require(
        signedAttributes.get(PKCSObjectIdentifiers.id_aa_signingCertificate) == null,
        pdf + " must not use legacy SHA-1 ESSCertID");
    Attribute signingCertificateV2 =
        signedAttributes.get(PKCSObjectIdentifiers.id_aa_signingCertificateV2);
    require(signingCertificateV2 != null, pdf + " is missing SigningCertificateV2");
    require(
        signingCertificateV2.getAttrValues().size() == 1,
        pdf + " must contain one SigningCertificateV2 value");
    SigningCertificateV2 signingCertificate =
        SigningCertificateV2.getInstance(signingCertificateV2.getAttrValues().getObjectAt(0));
    ESSCertIDv2[] certificateIds = signingCertificate.getCerts();
    require(certificateIds.length == 1, pdf + " must contain exactly one ESSCertIDv2");
    ESSCertIDv2 certificateId = certificateIds[0];
    ASN1ObjectIdentifier hashAlgorithm = certificateId.getHashAlgorithm().getAlgorithm();
    require(
        NISTObjectIdentifiers.id_sha256.equals(hashAlgorithm),
        pdf + " ESSCertIDv2 must use SHA-256");
    byte[] expectedHash = MessageDigest.getInstance("SHA-256").digest(tsaCertificate.getEncoded());
    require(
        Arrays.equals(expectedHash, certificateId.getCertHash()),
        pdf + " ESSCertIDv2 certificate hash does not match");
    IssuerSerial issuerSerial = certificateId.getIssuerSerial();
    require(issuerSerial != null, pdf + " ESSCertIDv2 must include issuer and serial");
    BigInteger serial = issuerSerial.getSerial().getValue();
    require(
        tsaCertificate.getSerialNumber().equals(serial),
        pdf + " ESSCertIDv2 serial number does not match");
    GeneralName[] issuerNames = issuerSerial.getIssuer().getNames();
    require(
        issuerNames.length == 1 && issuerNames[0].getTagNo() == GeneralName.directoryName,
        pdf + " ESSCertIDv2 issuer must be one directory name");
    X500Name issuer = X500Name.getInstance(issuerNames[0].getName());
    require(tsaCertificate.getIssuer().equals(issuer), pdf + " ESSCertIDv2 issuer does not match");
  }

  private static void writeReports(Reports reports, Path directory, String name)
      throws IOException {
    Files.writeString(
        directory.resolve("dss-" + name + "-simple.xml"),
        reports.getXmlSimpleReport(),
        StandardCharsets.UTF_8);
    Files.writeString(
        directory.resolve("dss-" + name + "-detailed.xml"),
        reports.getXmlDetailedReport(),
        StandardCharsets.UTF_8);
    Files.writeString(
        directory.resolve("dss-" + name + "-diagnostic.xml"),
        reports.getXmlDiagnosticData(),
        StandardCharsets.UTF_8);
    Files.writeString(
        directory.resolve("dss-" + name + "-etsi.xml"),
        reports.getXmlValidationReport(),
        StandardCharsets.UTF_8);
  }

  private static void require(boolean condition, String message) {
    if (!condition) {
      throw new IllegalStateException(message);
    }
  }
}
