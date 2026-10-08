package id.co.jasaraharja.paymentgw.repository;

import id.co.jasaraharja.paymentgw.entity.Payment;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface PaymentRepository extends JpaRepository<Payment, Long> {
    Optional<Payment> findByTransactionId(String transactionId);
    boolean existsByTransactionId(String transactionId);
}