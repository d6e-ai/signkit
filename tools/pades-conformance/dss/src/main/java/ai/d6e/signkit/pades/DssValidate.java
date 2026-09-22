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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Date;
import java.util.List;

public final class DssValidate {
    private static final Instant VALIDATION_TIME = Instant.parse("2026-09-23T00:00:00Z");

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
        addTrustedCertificate(trust, fixtureDirectory.resolve("trust/signer.pem"));
        addTrustedCertificate(trust, fixtureDirectory.resolve("trust/tsa.pem"));

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
        validateTampered(
                fixtureDirectory.resolve("tampered-b-b.pdf"),
                reportsDirectory,
                "tampered-b-b",
                verifier);
        validateTampered(
                fixtureDirectory.resolve("tampered-b-t.pdf"),
                reportsDirectory,
                "tampered-b-t",
                verifier);

        Files.writeString(reportsDirectory.resolve("dss-version.txt"), "6.5\n", StandardCharsets.UTF_8);
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

    private static void validateTampered(
            Path pdf,
            Path reportsDirectory,
            String reportName,
            CommonCertificateVerifier verifier)
            throws IOException {
        Validated validated = validate(pdf, verifier);
        writeReports(validated.reports(), reportsDirectory, reportName);
        require(
                !validated.simple().isValid(validated.signatureId()),
                pdf + " unexpectedly accepted a signed-byte mutation");
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
