package id.co.jasaraharja.paymentgw.dto;

import id.co.jasaraharja.paymentgw.entity.Payment.PaymentStatus;
import java.math.BigDecimal;
import java.time.LocalDateTime;

public record PaymentResponseDTO(
    Long id,
    String transactionId,
    BigDecimal amount,
    String payerName,
    String paymentMethod,
    PaymentStatus status,
    LocalDateTime createdAt,
    LocalDateTime updatedAt
) {}