package id.co.jasaraharja.paymentgw.service;

import id.co.jasaraharja.paymentgw.dto.PaymentRequestDTO;
import id.co.jasaraharja.paymentgw.dto.PaymentResponseDTO;
import id.co.jasaraharja.paymentgw.entity.Payment;
import id.co.jasaraharja.paymentgw.repository.PaymentRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
public class PaymentService {

    private final PaymentRepository paymentRepository;

    public PaymentService(PaymentRepository paymentRepository) {
        this.paymentRepository = paymentRepository;
    }

    @Transactional
    public PaymentResponseDTO createPayment(PaymentRequestDTO request) {
        if (paymentRepository.existsByTransactionId(request.transactionId())) {
            throw new IllegalArgumentException("Transaction ID already exists: " + request.transactionId());
        }

        Payment payment = new Payment(
                request.transactionId(),
                request.amount(),
                request.payerName(),
                request.paymentMethod(),
                request.status() != null ? request.status() : Payment.PaymentStatus.PENDING
        );

        Payment saved = paymentRepository.save(payment);
        return mapToDTO(saved);
    }

    @Transactional(readOnly = true)
    public List<PaymentResponseDTO> getAllPayments() {
        return paymentRepository.findAll().stream()
                .map(this::mapToDTO)
                .toList();
    }

    @Transactional(readOnly = true)
    public PaymentResponseDTO getPaymentById(Long id) {
        Payment payment = paymentRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("Payment not found with ID: " + id));
        return mapToDTO(payment);
    }

    @Transactional
    public PaymentResponseDTO updatePayment(Long id, PaymentRequestDTO request) {
        Payment payment = paymentRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("Payment not found with ID: " + id));

        payment.setAmount(request.amount());
        payment.setPayerName(request.payerName());
        payment.setPaymentMethod(request.paymentMethod());
        if (request.status() != null) {
            payment.setStatus(request.status());
        }

        Payment updated = paymentRepository.save(payment);
        return mapToDTO(updated);
    }

    @Transactional
    public void deletePayment(Long id) {
        if (!paymentRepository.existsById(id)) {
            throw new RuntimeException("Payment not found with ID: " + id);
        }
        paymentRepository.deleteById(id);
    }

    private PaymentResponseDTO mapToDTO(Payment payment) {
        return new PaymentResponseDTO(
                payment.getId(),
                payment.getTransactionId(),
                payment.getAmount(),
                payment.getPayerName(),
                payment.getPaymentMethod(),
                payment.getStatus(),
                payment.getCreatedAt(),
                payment.getUpdatedAt()
        );
    }
}