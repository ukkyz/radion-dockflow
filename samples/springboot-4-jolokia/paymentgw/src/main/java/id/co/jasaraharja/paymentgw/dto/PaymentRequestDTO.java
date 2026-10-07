package id.co.jasaraharja.paymentgw.dto;

import id.co.jasaraharja.paymentgw.entity.Payment.PaymentStatus;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;

public record PaymentRequestDTO(
    @NotBlank(message = "Transaction ID is mandatory")
    String transactionId,

    @NotNull(message = "Amount is mandatory")
    @DecimalMin(value = "0.01", message = "Amount must be greater than zero")
    BigDecimal amount,

    @NotBlank(message = "Payer name is mandatory")
    String payerName,

    @NotBlank(message = "Payment method is mandatory")
    String paymentMethod,

    PaymentStatus status
) {}